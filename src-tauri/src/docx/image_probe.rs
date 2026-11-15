//! 图片尺寸嗅探：只读文件头，不解码像素。
//!
//! docx 的 `wp:extent` 需要图片宽高（EMU 单位）。egui 版用的是 `image` crate 的
//! `load_from_memory`，那相当于为了读两个整数而拉进整套解码器。这里手写 PNG/JPEG/GIF/BMP
//! 四种格式的头解析——docx 里能塞的也就这四种。解析不出来就跳过这张图，不让导出失败。

/// 返回 (宽, 高)；格式不认识或头部损坏返回 None
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    png(bytes)
        .or_else(|| gif(bytes))
        .or_else(|| bmp(bytes))
        .or_else(|| jpeg(bytes))
}

/// PNG：8 字节签名 + IHDR（宽高各 4 字节大端）
fn png(b: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if b.len() < 24 || b[..8] != SIG || &b[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
    let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
    nonzero(w, h)
}

/// GIF：GIF87a/GIF89a + 逻辑屏幕宽高（各 2 字节小端）
fn gif(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 10 || (&b[..6] != b"GIF87a" && &b[..6] != b"GIF89a") {
        return None;
    }
    let w = u16::from_le_bytes([b[6], b[7]]) as u32;
    let h = u16::from_le_bytes([b[8], b[9]]) as u32;
    nonzero(w, h)
}

/// BMP：BM + DIB 头里的宽高（各 4 字节小端，高度可能为负表示自上而下）
fn bmp(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 26 || &b[..2] != b"BM" {
        return None;
    }
    let w = i32::from_le_bytes([b[18], b[19], b[20], b[21]]);
    let h = i32::from_le_bytes([b[22], b[23], b[24], b[25]]);
    nonzero(w.unsigned_abs(), h.unsigned_abs())
}

/// JPEG：逐段扫描，找到 SOF0-SOF15（排除 DHT/JPG/DAC）就读宽高
fn jpeg(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        // 跳过填充的 0xFF
        let mut marker = b[i + 1];
        while marker == 0xFF && i + 2 < b.len() {
            i += 1;
            marker = b[i + 1];
        }
        // 无长度的段
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if i + 4 >= b.len() {
            return None;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            return None;
        }
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
        let is_sof = (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC;
        if is_sof {
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return nonzero(w, h);
        }
        i += 2 + len;
    }
    None
}

fn nonzero(w: u32, h: u32) -> Option<(u32, u32)> {
    if w == 0 || h == 0 {
        None
    } else {
        Some((w, h))
    }
}

/// 按文件头判断真实格式，用于纠正"文件名叫 .png 其实是 jpg"这类情况。
/// 只认 docx 的 Content_Types 里声明过的四种；webp/svg/avif 一律返回 None，
/// 由调用方跳过——硬塞进去 Word 会报文件损坏。
pub fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}
