//! 回归测试（主线补写）：zip/编码/docx 导出/大文档切片/大纲。
//! 跑法：cd /d/mojuan-tauri/src-tauri && CARGO_HOME=/d/cache/cargo-home
//!       CARGO_TARGET_DIR=/d/cache/mojuan-tauri-target cargo test

use std::fs;
use std::path::PathBuf;
use std::process::Command;

// ---------- zip / crc32 ----------

#[test]
fn crc32_known_vector() {
    // CRC-32 标准测试向量
    assert_eq!(crate::docx::zip::crc32(b"123456789"), 0xCBF43926);
    assert_eq!(crate::docx::zip::crc32(b""), 0);
}

#[test]
fn zip_structure_roundtrip() {
    let mut z = crate::docx::zip::Zip::new();
    z.add("[Content_Types].xml", b"hello");
    z.add("word/document.xml", "中文内容".as_bytes());
    let bytes = z.finish();
    // ZIP 魔数 + EOCD 魔数
    assert_eq!(&bytes[..2], b"PK");
    assert_eq!(&bytes[bytes.len() - 22..bytes.len() - 20], &b"PK"[..]);
    // STORED（无压缩）：本地头压缩方法 = 0
    let lh = &bytes[..30];
    assert_eq!(&lh[8..10], &b"\x00\x00"[..]);
}

// ---------- encoding ----------

#[test]
fn gbk_decode_and_roundtrip() {
    // "中文" 的 GBK 编码（0xD6 0xD0 0xCE 0xC4）
    let d = crate::encoding::decode(&[0xD6, 0xD0, 0xCE, 0xC4]);
    assert_eq!(d.text, "中文");
    assert_eq!(d.encoding, "gbk");
    // 往返：encode_gbk(原文) → decode → 原文
    let back = crate::encoding::encode_gbk("中文测试").unwrap();
    let d2 = crate::encoding::decode(&back);
    assert_eq!(d2.text, "中文测试");
}

#[test]
fn utf8_bom_and_plain_utf8() {
    let with_bom = crate::encoding::decode(&[0xEF, 0xBB, 0xBF, 0xE4, 0xB8, 0xAD]);
    assert_eq!(with_bom.encoding, "utf-8");
    assert_eq!(with_bom.text, "中");
    let plain = crate::encoding::decode("中文".as_bytes());
    assert_eq!(plain.encoding, "utf-8");
}

#[test]
fn gbk_unmappable_rejected() {
    // emoji 无法映射到 GBK，必须明确报错（而不是写坏文件）
    assert!(crate::encoding::encode_gbk("中文😀").is_err());
}

// ---------- docx 导出 ----------

fn temp_dir() -> PathBuf {
    let d = std::env::temp_dir().join("mojuan-tauri-tests");
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn docx_export_smoke() {
    let md = temp_dir().join("docx-smoke.md");
    fs::write(
        &md,
        "# 标题\n\n正文**加粗**与`行内码`。\n\n## 小节\n\n- 列表项\n- [ ] 任务\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n```rust\nlet a = 1;\n```\n\n[链接](https://example.com)\n",
    )
    .unwrap();
    let out = temp_dir().join("docx-smoke.docx");
    let _ = fs::remove_file(&out);
    crate::docx::export_md_to_docx(&md, &out).unwrap();

    let bytes = fs::read(&out).unwrap();
    assert_eq!(&bytes[..2], b"PK", "产物应为 zip");
    // OPC 要求 [Content_Types].xml 是第一个 part（本地头 30 字节后即文件名）
    let name_len =
        u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
    assert_eq!(
        &bytes[30..30 + name_len.min(20)],
        &b"[Content_Types].xml"[..name_len.min(19)],
        "第一个 part 必须是 [Content_Types].xml"
    );
    // ZIP 没有坏尾：EOCD 魔数存在
    assert!(bytes.windows(4).any(|w| w == b"PK\x05\x06"));
}

#[test]
fn docx_export_rejects_huge_garbage() {
    // 不存在的输入 → 中文错误，不产出坏包
    let out = temp_dir().join("never.docx");
    let _ = fs::remove_file(&out);
    let err = crate::docx::export_md_to_docx(PathBuf::from("D:/no-such-9x.md").as_path(), &out)
        .unwrap_err();
    assert!(!err.is_empty());
    assert!(!out.exists());
}

// ---------- 大文档切片 / 大纲（纯函数，构造 VIndex） ----------

fn big_md(paras: usize) -> String {
    let mut s = String::with_capacity(paras * 80);
    for i in 0..paras {
        s.push_str(&format!("## 章节{i}\n\n第{i}段测试文本：内容足够长以形成独立块。\n\n"));
    }
    s
}

#[test]
fn doc_blocks_slice_and_outline() {
    let text = big_md(300); // ~300 段 + 300 标题，600 块量级
    let idx = mojuan_core::vindex::VIndex::build(&text);
    let total = idx.blocks.len();
    assert!(total > 300, "应切成 {total} 块");

    let lines = crate::commands::files::block_start_lines(&text, &idx);
    // 第一页
    let p0 = crate::commands::files::build_blocks(&text, &idx, &lines, 0, 40);
    assert_eq!(p0.blocks.len(), 40.min(total));
    assert_eq!(p0.total, total);
    assert!(!p0.done || total <= 40);
    // 越界页
    let p1 = crate::commands::files::build_blocks(&text, &idx, &lines, total + 10, 40);
    assert_eq!(p1.blocks.len(), 0);
    // 末页 done
    let last = crate::commands::files::build_blocks(&text, &idx, &lines, total - 1, 40);
    assert_eq!(last.blocks.len(), 1);
    assert!(last.done);

    let outline = crate::commands::files::build_outline(&text, &idx, &lines);
    assert_eq!(outline.len(), 300);
    assert_eq!(outline[7].text, "章节7");
    assert_eq!(outline[7].level, 2);
}

// ---------- 命令层整体可执行性（调用真实 tauri 命令需要 AppHandle，这里验证 npm 构建链路） ----------

#[test]
#[ignore = "W3/W5 前端构建中，集成期启用"]
fn frontend_build_passes() {
    // 前端 tsc + vite build 必须无类型错误（防 W3/W5 改挂）
    let root = PathBuf::from("D:/mojuan-tauri");
    let out = Command::new("npm")
        .args(["run", "build"])
        .current_dir(&root)
        .output()
        .expect("npm 运行失败");
    assert!(
        out.status.success(),
        "npm build 失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
