//! 文本编码：BOM 嗅探、UTF-8/UTF-16 解码、GBK 解码与编码。
//!
//! 为什么不直接用 core 的 `files::read_doc`：那个函数只返回文本，不告诉我们原编码，
//! 而前端保存时要按原编码写回（GBK 的旧笔记不能被悄悄改成 UTF-8）。这里补上
//! 「编码标签」与「编码器」，解码顺序与 core 完全一致：
//! BOM 优先 → 严格 UTF-8 → GBK（系统 CP936，不往 exe 里塞编码表）。

/// 对外暴露的编码名（与 api-contract 一致，只有这两种可写）
pub const ENC_UTF8: &str = "utf-8";
pub const ENC_GBK: &str = "gbk";

/// 解码结果
pub struct Decoded {
    pub text: String,
    /// "utf-8" / "gbk"（UTF-16 源文件解出来的文本仍按 utf-8 报，见 decode 注释）
    pub encoding: &'static str,
}

/// 按 BOM → 严格 UTF-8 → GBK 的顺序解码。
///
/// UTF-16 文件能正确读出内容，但对外的 encoding 一律报 "utf-8"：
/// 契约只允许写回 utf-8/gbk，报 utf-16 会让前端以为「保存会毁文件」而卡住。
/// 实际效果是内容无损、编码归一成 UTF-8，比报错友好。
pub fn decode(bytes: &[u8]) -> Decoded {
    // UTF-16 LE（老记事本的「Unicode」）
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Decoded {
            text: strip_bom(String::from_utf16_lossy(&units)),
            encoding: ENC_UTF8,
        };
    }
    // UTF-16 BE
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return Decoded {
            text: strip_bom(String::from_utf16_lossy(&units)),
            encoding: ENC_UTF8,
        };
    }
    // UTF-8 BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Decoded {
            text: strip_bom(String::from_utf8_lossy(&bytes[3..]).into_owned()),
            encoding: ENC_UTF8,
        };
    }
    // 严格 UTF-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Decoded {
            text: s.to_string(),
            encoding: ENC_UTF8,
        };
    }
    // GBK 兜底
    Decoded {
        text: decode_gbk(bytes),
        encoding: ENC_GBK,
    }
}

fn strip_bom(s: String) -> String {
    match s.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

/// 前端传来的编码名归一化。只接受 utf-8 / gbk（含常见别名）。
pub fn normalize(name: &str) -> Result<&'static str, String> {
    let n = name.trim().to_ascii_lowercase().replace('_', "-");
    match n.as_str() {
        "" | "utf-8" | "utf8" => Ok(ENC_UTF8),
        "gbk" | "gb2312" | "gb18030" | "cp936" => Ok(ENC_GBK),
        other => Err(format!(
            "不认识的编码「{other}」，只支持 utf-8 或 gbk"
        )),
    }
}

#[cfg(windows)]
fn decode_gbk(bytes: &[u8]) -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            src: *const u8,
            src_len: i32,
            dst: *mut u16,
            dst_len: i32,
        ) -> i32;
    }
    const CP_GBK: u32 = 936;
    const MB_ERR_INVALID_CHARS: u32 = 8;
    unsafe {
        // 先严格转换（暴露坏字节），失败则宽松重转，最后实在不行按 UTF-8 lossy
        let strict = MultiByteToWideChar(
            CP_GBK,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        let flags = if strict > 0 { MB_ERR_INVALID_CHARS } else { 0 };
        let n = if strict > 0 {
            strict
        } else {
            MultiByteToWideChar(
                CP_GBK,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                std::ptr::null_mut(),
                0,
            )
        };
        if n <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut buf = vec![0u16; n as usize];
        MultiByteToWideChar(
            CP_GBK,
            flags,
            bytes.as_ptr(),
            bytes.len() as i32,
            buf.as_mut_ptr(),
            n,
        );
        String::from_utf16_lossy(&buf)
    }
}

#[cfg(not(windows))]
fn decode_gbk(bytes: &[u8]) -> String {
    // 非 Windows 构建没有系统 GBK 表，退化为 UTF-8 lossy（与 core 一致）
    String::from_utf8_lossy(bytes).into_owned()
}

/// UTF-8 字符串 → GBK 字节。遇到 GBK 表示不了的字符（emoji、生僻字等）返回中文错误，
/// 并指出第一个出问题的字符，方便用户自己改。
pub fn encode_gbk(text: &str) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        win::encode(text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("当前平台不支持保存为 GBK，请改用 UTF-8".to_string())
    }
}

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        fn WideCharToMultiByte(
            code_page: u32,
            flags: u32,
            src: *const u16,
            src_len: i32,
            dst: *mut u8,
            dst_len: i32,
            default_char: *const u8,
            used_default_char: *mut i32,
        ) -> i32;
    }

    const CP_GBK: u32 = 936;
    /// 不启用"最佳匹配"降级，遇到表示不了的字符就置 used_default 标记
    const WC_NO_BEST_FIT_CHARS: u32 = 0x0000_0400;

    fn convert(wide: &[u16], dst: Option<&mut [u8]>) -> (i32, i32) {
        let mut used: i32 = 0;
        let (ptr, len) = match dst {
            Some(buf) => (buf.as_mut_ptr(), buf.len() as i32),
            None => (std::ptr::null_mut(), 0),
        };
        let n = unsafe {
            WideCharToMultiByte(
                CP_GBK,
                WC_NO_BEST_FIT_CHARS,
                wide.as_ptr(),
                wide.len() as i32,
                ptr,
                len,
                std::ptr::null(),
                &mut used,
            )
        };
        (n, used)
    }

    pub fn encode(text: &str) -> Result<Vec<u8>, String> {
        // 空文件是合法状态（新建文档还没写东西），直接给空字节
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let wide: Vec<u16> = text.encode_utf16().collect();
        let (need, _) = convert(&wide, None);
        if need <= 0 {
            return Err("GBK 编码失败：文本无法转换".into());
        }
        let mut buf = vec![0u8; need as usize];
        let (n, used) = convert(&wide, Some(&mut buf));
        if n <= 0 {
            return Err("GBK 编码失败：文本无法转换".into());
        }
        buf.truncate(n as usize);
        if used != 0 {
            let bad = text.chars().find(|c| !can_encode(*c));
            return Err(match bad {
                Some(c) => format!("字符「{c}」无法用 GBK 表示，请改用 UTF-8 保存"),
                None => "内容里有 GBK 无法表示的字符，请改用 UTF-8 保存".to_string(),
            });
        }
        Ok(buf)
    }

    fn can_encode(c: char) -> bool {
        let mut units = [0u16; 2];
        let wide = c.encode_utf16(&mut units);
        // 真正转一次（哪怕只有 1-2 字节），否则 used_default 不一定被写回
        let mut tiny = [0u8; 8];
        let (n, used) = convert(wide, Some(&mut tiny));
        n > 0 && used == 0
    }
}
