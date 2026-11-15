//! Word (.docx) 生成器：手写 OOXML + 手写 STORED ZIP，零新依赖。
//!
//! 从 egui 版 `crates/app/src/export.rs` 的 docx 部分平移而来，改动只有三处：
//! 1. 图片尺寸不再用 `image` crate 解码，改成本模块 `image_probe` 读文件头；
//! 2. 分块逻辑内联（原来依赖 `ui::vpreview::VIRTUAL_THRESHOLD`）；
//! 3. 入口从「(&str, base, title, out)」变成「(md_path, out_path)」，标题取文件名。
//!
//! 正文块来源仍是 core 的 comrak 解析（`mojuan_core::doc::parse`），排版映射规则与原版一致。

mod image_probe;
pub(crate) mod zip;

use std::path::{Path, PathBuf};

use mojuan_core::doc::{Block, ListItem, Run};
use mojuan_core::vindex::VIndex;

use zip::Zip;

/// 超过这个字节数就按 VIndex 分块解析（与 egui 版虚拟预览阈值一致），
/// 避免千万字文档一次性建出数百万 AST 节点
const CHUNK_THRESHOLD: usize = 180_000;

/// 远程图片最大字节数（走 WinHTTP，必须有上限，否则一个坏链接能拖死导出）
const MAX_REMOTE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// 本地图片最大字节数：比远程宽松（手机照片常有十几 MB），但也要有上限，
/// 否则一张 500MB 的 TIFF 会把 docx 撑爆
const MAX_LOCAL_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 生成一个带格式的 `<w:r>`。
///
/// `w:rPr` 的子元素**必须**按 OOXML schema 顺序排列，否则 Word 打开时会提示
/// "内容有问题需要修复"：rFonts → b → i → strike → color → sz → shd。
/// egui 原版这里顺序是乱的（color 在前、shd 在 sz 前），平移时顺手修正。
fn run_xml(text: &str, bold: bool, italic: bool, strike: bool, code: bool, dim: bool) -> String {
    let mut rpr = String::new();
    if code {
        rpr.push_str(
            "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"Microsoft YaHei\"/>",
        );
    }
    if bold {
        rpr.push_str("<w:b/>");
    }
    if italic {
        rpr.push_str("<w:i/>");
    }
    if strike {
        rpr.push_str("<w:strike/>");
    }
    if dim {
        rpr.push_str("<w:color w:val=\"595959\"/>");
    }
    if code {
        // 行内代码：小一号 + 浅灰底
        rpr.push_str("<w:sz w:val=\"19\"/><w:shd w:val=\"clear\" w:fill=\"EFEFEF\"/>");
    }
    format!(
        "<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(&xml_clean(text))
    )
}

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ---------------------------------------------------------------------------
// XML 基础
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '&' => o.push_str("&amp;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
    o
}

/// 去掉 XML 1.0 不允许的控制字符（否则 Word 打不开）
fn xml_clean(s: &str) -> String {
    s.chars()
        .filter(|&c| c == '\t' || c == '\n' || c == '\r' || c >= '\u{20}')
        .collect()
}

// ---------------------------------------------------------------------------
// 文档构建
// ---------------------------------------------------------------------------

struct DocxBuilder {
    zip: Zip,
    /// (rId, 目标, 是否外链)
    rels: Vec<(String, String, bool)>,
    body: String,
    rid: usize,
    img_i: usize,
}

impl DocxBuilder {
    fn new() -> Self {
        // [Content_Types].xml 必须是包里的第一个 part（OPC 约定，Word 靠它认格式），
        // 所以在这里就写进去；图片随后追加，不会跑到它前面。
        let mut zip = Zip::new();
        zip.add("[Content_Types].xml", include_bytes!("content_types.xml"));
        zip.add("_rels/.rels", include_bytes!("rels.xml"));
        zip.add("word/styles.xml", include_str!("styles.xml").as_bytes());
        Self {
            zip,
            rels: Vec::new(),
            body: String::with_capacity(1 << 16),
            rid: 0,
            img_i: 0,
        }
    }

    fn next_rid(&mut self) -> String {
        self.rid += 1;
        format!("rId{}", self.rid)
    }

    /// 列表项里用的简单 run（带样式开关）
    fn text_run(&mut self, text: &str, bold: bool, italic: bool, strike: bool, code: bool) {
        if text.is_empty() {
            return;
        }
        self.body
            .push_str(&run_xml(text, bold, italic, strike, code, false));
    }

    /// 超链接 run：地址登记到 rels（TargetMode=External）
    fn link_run(&mut self, url: &str, text: &str) {
        let rid = self.next_rid();
        self.rels.push((rid.clone(), url.to_string(), true));
        self.body.push_str(&format!(
            "<w:hyperlink r:id=\"{rid}\"><w:r><w:rPr><w:color w:val=\"0067C0\"/><w:u w:val=\"single\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:hyperlink>",
            xml_escape(&xml_clean(text))
        ));
    }

    /// 普通段落（runs 可带链接）
    fn para_of(&mut self, runs: &[Run], props: &str, force_bold: bool, dim: bool) {
        self.body.push_str("<w:p>");
        if !props.is_empty() {
            self.body.push_str(&format!("<w:pPr>{props}</w:pPr>"));
        }
        for r in runs {
            if let Some(url) = &r.link {
                self.link_run(url, &r.text);
                continue;
            }
            self.body.push_str(&run_xml(
                &r.text,
                force_bold || r.bold,
                r.italic,
                r.strike,
                r.code,
                dim,
            ));
        }
        self.body.push_str("</w:p>");
    }

    fn write_blocks(&mut self, blocks: &[Block], base: Option<&Path>) {
        for b in blocks {
            self.write_block(b, base, 0);
        }
    }

    fn write_block(&mut self, b: &Block, base: Option<&Path>, level: usize) {
        match b {
            Block::Heading { level: hl, runs, .. } => {
                let style = match hl {
                    1..=4 => format!("Heading{hl}"),
                    _ => "Heading4".to_string(),
                };
                self.para_of(runs, &format!("<w:pStyle w:val=\"{style}\"/>"), true, false);
            }
            Block::Para(runs) => self.para_of(runs, "", false, false),
            Block::Code { lines, .. } => {
                // 字面量代码块：每行一个段落，行间零间距，首行加上边框、末行加下边框，
                // 视觉上是一整块灰底。这里不吃 core 的语法高亮（导出的是"代码原文"，
                // 颜色靠 Word 那边自己定，省得 token 颜色与 Word 主题打架）。
                let n = lines.len();
                for (i, cl) in lines.iter().enumerate() {
                    // 边框必须合并成一个 pBdr（OOXML 里 pBdr 只能出现一次），
                    // 单行代码块同时是首行和末行，原版会写两个 pBdr，Word 会挑刺
                    let mut borders = String::new();
                    if i == 0 {
                        borders.push_str("<w:top w:val=\"single\" w:sz=\"4\" w:color=\"E8E8E8\"/>");
                    }
                    if i + 1 == n {
                        borders
                            .push_str("<w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"E8E8E8\"/>");
                    }
                    // pPr 顺序按 schema：pBdr → shd → spacing → ind
                    let mut props = String::new();
                    if !borders.is_empty() {
                        props.push_str(&format!("<w:pBdr>{borders}</w:pBdr>"));
                    }
                    props.push_str(
                        "<w:shd w:val=\"clear\" w:fill=\"F6F6F6\"/>\
                         <w:spacing w:after=\"0\" w:line=\"276\" w:lineRule=\"auto\"/>\
                         <w:ind w:left=\"113\" w:right=\"113\"/>",
                    );
                    self.body.push_str(&format!("<w:p><w:pPr>{props}</w:pPr>"));
                    for t in cl {
                        self.body.push_str(&format!(
                            "<w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"Microsoft YaHei\"/><w:sz w:val=\"19\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                            xml_escape(&xml_clean(&t.text))
                        ));
                    }
                    self.body.push_str("</w:p>");
                }
            }
            Block::Quote(inner) => {
                for q in inner {
                    match q {
                        Block::Para(runs) => self.para_of(
                            runs,
                            // pPr 顺序：pBdr → spacing → ind
                            "<w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:color=\"C9C9C9\"/></w:pBdr><w:spacing w:after=\"120\"/><w:ind w:left=\"340\"/>",
                            false,
                            true,
                        ),
                        other => self.write_block(other, base, level),
                    }
                }
            }
            Block::List { ordered, start, items } => {
                for (i, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", *start + i as u64)
                    } else {
                        "• ".to_string()
                    };
                    self.write_list_item(item, &marker, level, base);
                }
            }
            Block::Table { head, rows, .. } => self.write_table(head, rows),
            Block::Rule => {
                self.body.push_str(
                    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:color=\"E5E5E5\"/></w:pBdr><w:spacing w:after=\"240\"/></w:pPr></w:p>",
                );
            }
            Block::Image { src, path, alt, .. } => self.write_image(src, path.as_deref(), alt, base),
        }
    }

    fn write_list_item(&mut self, item: &ListItem, marker: &str, level: usize, base: Option<&Path>) {
        let indent = 340 + level as i32 * 340;
        // pPr 顺序按 schema：spacing → ind
        let props = format!("<w:spacing w:after=\"60\"/><w:ind w:left=\"{indent}\" w:hanging=\"227\"/>");
        for b in &item.blocks {
            match b {
                Block::Para(runs) => {
                    let task = match item.task {
                        Some(true) => "☑ ",
                        Some(false) => "☐ ",
                        None => "",
                    };
                    self.body.push_str(&format!("<w:p><w:pPr>{props}</w:pPr>"));
                    self.text_run(&format!("{marker}{task}"), false, false, false, false);
                    for r in runs {
                        if let Some(url) = &r.link {
                            self.link_run(url, &r.text);
                            continue;
                        }
                        self.text_run(&r.text, r.bold, r.italic, r.strike, r.code);
                    }
                    self.body.push_str("</w:p>");
                }
                other => self.write_block(other, base, level + 1),
            }
        }
    }

    fn write_table(&mut self, head: &[Vec<Run>], rows: &[Vec<Vec<Run>>]) {
        let cols = head.len().max(1);
        let mut grid = String::new();
        for _ in 0..cols {
            grid.push_str("<w:gridCol/>");
        }
        self.body.push_str(&format!(
            "<w:tbl><w:tblPr><w:tblW w:w=\"5000\" w:type=\"pct\"/><w:tblBorders>\
             <w:top w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/>\
             <w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/>\
             <w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"E3E3E3\"/>\
             </w:tblBorders></w:tblPr><w:tblGrid>{grid}</w:tblGrid>"
        ));
        let cell = |b: &mut Self, runs: &[Run], head_cell: bool| {
            b.body.push_str("<w:tc><w:tcPr>");
            if head_cell {
                b.body.push_str("<w:shd w:val=\"clear\" w:fill=\"F7F7F7\"/>");
            }
            b.body.push_str("</w:tcPr><w:p>");
            for r in runs {
                b.body.push_str(&run_xml(
                    &r.text,
                    head_cell || r.bold,
                    r.italic,
                    r.strike,
                    r.code,
                    false,
                ));
            }
            b.body.push_str("</w:p></w:tc>");
        };
        self.body.push_str("<w:tr>");
        for r in head {
            cell(self, r, true);
        }
        self.body.push_str("</w:tr>");
        for row in rows {
            self.body.push_str("<w:tr>");
            for r in row {
                cell(self, r, false);
            }
            self.body.push_str("</w:tr>");
        }
        self.body.push_str("</w:tbl><w:p/>");
    }

    /// 图片：本地读文件 / 远程走 core 的 WinHTTP；尺寸从文件头嗅探
    ///
    /// 格式以**文件头**为准（不信扩展名）：Word 只认 png/jpeg/gif/bmp，
    /// webp、svg、avif 一律跳过——硬塞会导致 Word 报"文档已损坏"。
    fn write_image(&mut self, src: &str, path: Option<&Path>, alt: &str, base: Option<&Path>) {
        let bytes: Option<Vec<u8>> = if let Some(p) = path {
            read_local_limited(p)
        } else if src.starts_with("http://") || src.starts_with("https://") {
            mojuan_core::http::https_get(src, MAX_REMOTE_IMAGE_BYTES, 8000)
                .ok()
                .filter(|r| r.status == 200)
                .map(|r| r.body)
        } else if let Some(b) = base {
            read_local_limited(&b.join(src))
        } else {
            None
        };
        // 尺寸、格式任一读不出来就跳过这张图——图片坏了不该让整个导出失败
        let found = bytes
            .and_then(|b| image_probe::sniff_ext(&b).map(|ext| (b, ext)))
            .and_then(|(b, ext)| image_probe::dimensions(&b).map(|(w, h)| (b, ext, w, h)));
        let Some((bytes, ext, w, h)) = found else {
            // rPr 顺序：i → color
            self.body.push_str(&format!(
                "<w:p><w:r><w:rPr><w:i/><w:color w:val=\"949494\"/></w:rPr><w:t xml:space=\"preserve\">（图片无法加载：{}）</w:t></w:r></w:p>",
                xml_escape(&xml_clean(if alt.is_empty() { src } else { alt }))
            ));
            return;
        };
        self.img_i += 1;
        let file = format!(
            "media/image{}.{}",
            self.img_i,
            if ext == "jpeg" { "jpg" } else { ext }
        );
        self.zip.add(&format!("word/{file}"), &bytes);
        let rid = self.next_rid();
        self.rels.push((rid.clone(), file, false));

        // 宽超过 600px 就等比缩到 600px（EMU = 1/914400 英寸，1px ≈ 9525 EMU）
        let scale = (600.0 / w as f32).min(1.0);
        let dw = (w as f32 * scale) as i64 * 9525;
        let dh = (h as f32 * scale) as i64 * 9525;
        self.body.push_str(&format!(
            "<w:p><w:r><w:drawing>\
             <wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\">\
             <wp:extent cx=\"{dw}\" cy=\"{dh}\"/><wp:docPr id=\"{}\" name=\"Picture {}\"/>\
             <a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">\
             <a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
             <pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
             <pic:nvPicPr><pic:cNvPr id=\"{}\" name=\"Picture {}\"/><pic:cNvPicPr/></pic:nvPicPr>\
             <pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
             <pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{dw}\" cy=\"{dh}\"/></a:xfrm>\
             <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
             </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
            self.img_i, self.img_i, self.img_i, self.img_i
        ));
    }

    /// 补齐固定部件（样式/关系/文档属性），返回完整 zip 字节
    fn finish(mut self, title: &str) -> Result<Vec<u8>, String> {
        // 固定部件（[Content_Types].xml / _rels/.rels / styles.xml）在 new() 里已先写入，
        // 这里只补关系表、正文与文档属性。
        let mut rels = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
        );
        for (rid, target, external) in &self.rels {
            let (t, mode) = if *external {
                (
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                    " TargetMode=\"External\"",
                )
            } else {
                (
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                    "",
                )
            };
            rels.push_str(&format!(
                "<Relationship Id=\"{rid}\" Type=\"{t}\" Target=\"{}\"{mode}/>",
                xml_escape(target)
            ));
        }
        rels.push_str("</Relationships>");
        self.zip
            .add("word/_rels/document.xml.rels", rels.as_bytes());

        let body = std::mem::take(&mut self.body);
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\"><w:body>{body}\
             <w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
             <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/>\
             </w:sectPr></w:body></w:document>"
        );
        self.zip.add("word/document.xml", doc.as_bytes());
        self.zip.add(
            "docProps/core.xml",
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
                 <cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" \
                 xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>墨卷</dc:creator></cp:coreProperties>",
                xml_escape(&xml_clean(title))
            )
            .as_bytes(),
        );
        self.zip.add(
            "docProps/app.xml",
            b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
              <Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">\
              <Application>Mojuan</Application></Properties>",
        );
        if self.zip.overflowed() {
            return Err("文档太大，超过 Word 单文件上限（约 4GB）".into());
        }
        Ok(self.zip.finish())
    }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 读本地图片，超过上限直接放弃（返回 None 会让该图渲染成"无法加载"提示）
fn read_local_limited(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_LOCAL_IMAGE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// 把 Markdown 文件导成 docx。
///
/// 标题取源文件名（不含扩展名）；图片相对路径以源文件所在目录为基准。
pub fn export_md_to_docx(md_path: &Path, out_path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(md_path).map_err(|e| format!("找不到源文件：{e}"))?;
    if !meta.is_file() {
        return Err("源路径不是文件".into());
    }
    // 复用 core 的读取（BOM/UTF-8/GBK 兜底），与阅读时看到的内容完全一致
    let (text, _crlf) = mojuan_core::files::read_doc(md_path)?;
    let base: Option<PathBuf> = md_path.parent().map(|p| p.to_path_buf());
    let base = base.as_deref();
    let title = md_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".into());

    let mut b = DocxBuilder::new();
    // txt 按纯文本排（每行一段），与阅读区的 parse_plain 行为一致；
    // md 走 comrak 解析。不看扩展名而一律当 Markdown 会把 `#`、`*` 误当语法。
    let plain = mojuan_core::files::ext_of(md_path) == "txt";
    if text.len() > CHUNK_THRESHOLD {
        // 大文档：按 VIndex 逐块解析，内存占用与文档长度无关
        let idx = VIndex::build(&text);
        for i in 0..idx.blocks.len() {
            let slice = idx.slice(&text, i);
            let blocks = if plain {
                mojuan_core::doc::parse_plain(slice).blocks
            } else {
                mojuan_core::doc::parse(slice, base).blocks
            };
            b.write_blocks(&blocks, base);
        }
    } else {
        let blocks = if plain {
            mojuan_core::doc::parse_plain(&text).blocks
        } else {
            mojuan_core::doc::parse(&text, base).blocks
        };
        b.write_blocks(&blocks, base);
    }
    let data = b.finish(&title)?;

    if let Some(dir) = out_path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    std::fs::write(out_path, data).map_err(|e| format!("保存 docx 失败：{e}"))?;
    Ok(())
}
