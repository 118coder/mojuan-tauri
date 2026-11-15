//! 极简 ZIP 打包器：只做 STORED（不压缩），够 docx 用。
//!
//! 为什么不用 `zip` crate：一次性导出只写十几个小文件，手写 200 行就能搞定，
//! 而 zip crate 会带进 flate2/miniz_oxide 一整条压缩链。这里保持"零新依赖"。

/// CRC32（IEEE 802.3，多项式 0xEDB88320），ZIP 用的就是它
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

pub struct Zip {
    out: Vec<u8>,
    /// (文件名, CRC, 大小, 本地头偏移)
    entries: Vec<(String, u32, u32, u32)>,
    /// 累计大小越过 ZIP32 上限时置位，由调用方检查后报错（不在底层 panic）
    overflow: bool,
}

impl Default for Zip {
    fn default() -> Self {
        Self::new()
    }
}

impl Zip {
    pub fn new() -> Self {
        Self {
            out: Vec::new(),
            entries: Vec::new(),
            overflow: false,
        }
    }

    /// 是否已经因为超过 4GB 而丢过内容
    pub fn overflowed(&self) -> bool {
        self.overflow
    }

    /// 追加一个文件（STORED）
    ///
    /// 只支持 ZIP32（单文件与总大小 < 4GB）。真越过上限时丢弃后续内容并置位
    /// `overflow`，让导出流程统一报「文档太大」的人话错误，而不是写出一个坏包。
    pub fn add(&mut self, name: &str, data: &[u8]) {
        if self.overflow {
            return;
        }
        if self.out.len() as u64 + data.len() as u64 > u32::MAX as u64 {
            self.overflow = true;
            return;
        }
        let crc = crc32(data);
        let offset = self.out.len() as u32;
        let n = name.as_bytes();
        let mut h = Vec::with_capacity(30 + n.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // 本地文件头签名
        h.extend_from_slice(&20u16.to_le_bytes()); // 解压所需版本 2.0
        h.extend_from_slice(&0u16.to_le_bytes()); // 压缩方式 0 = stored
        h.extend_from_slice(&0u16.to_le_bytes()); // 修改时间（不关心，写 0）
        h.extend_from_slice(&0x21u16.to_le_bytes()); // 修改日期（1980-01-01）
        h.extend_from_slice(&crc.to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(n.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
        h.extend_from_slice(n);
        self.out.extend_from_slice(&h);
        self.out.extend_from_slice(data);
        self.entries
            .push((name.to_string(), crc, data.len() as u32, offset));
    }

    /// 写中央目录 + EOCD，收工
    pub fn finish(mut self) -> Vec<u8> {
        let cd_start = self.out.len() as u32;
        let mut cd = Vec::new();
        for (name, crc, size, offset) in &self.entries {
            let n = name.as_bytes();
            cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes()); // 创建版本
            cd.extend_from_slice(&20u16.to_le_bytes()); // 解压所需版本
            cd.extend_from_slice(&0u16.to_le_bytes()); // 标志位
            cd.extend_from_slice(&0u16.to_le_bytes()); // 压缩方式
            cd.extend_from_slice(&0u16.to_le_bytes()); // 时间
            cd.extend_from_slice(&0x21u16.to_le_bytes()); // 日期
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&size.to_le_bytes());
            cd.extend_from_slice(&size.to_le_bytes());
            cd.extend_from_slice(&(n.len() as u16).to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段
            cd.extend_from_slice(&0u16.to_le_bytes()); // 注释
            cd.extend_from_slice(&0u16.to_le_bytes()); // 起始磁盘号
            cd.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
            cd.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
            cd.extend_from_slice(&offset.to_le_bytes());
            cd.extend_from_slice(n);
        }
        self.out.extend_from_slice(&cd);
        let count = self.entries.len() as u16;
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes()); // EOCD 签名
        self.out.extend_from_slice(&0u16.to_le_bytes()); // 当前磁盘
        self.out.extend_from_slice(&0u16.to_le_bytes()); // 中央目录起始磁盘
        self.out.extend_from_slice(&count.to_le_bytes());
        self.out.extend_from_slice(&count.to_le_bytes());
        self.out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        self.out.extend_from_slice(&cd_start.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        self.out
    }
}
