//! 1-bit bitmap -> printer-language encoders.
//!
//! Most printers that cannot take a PDF understand one of a handful of command languages. The
//! Android side renders each PDF page to a black/white bitmap (`PdfRenderer`), and these encoders
//! wrap it in the printer's own language, so one code path covers label printers (ZPL, TSPL, CPCL),
//! receipt printers (ESC/POS) and IPP printers that only take raster (PWG raster).
//!
//! No Tauri dependency, so it is unit-tested on any machine.

// Only the Android backend calls these; the other platforms just compile the shared commands.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

pub const LANG_ZPL: &str = "zpl";
pub const LANG_TSPL: &str = "tspl";
pub const LANG_ESCPOS: &str = "escpos";
pub const LANG_CPCL: &str = "cpcl";
pub const LANG_PWG: &str = "pwg";

/// Languages that are a plain command stream for a label/receipt printer (not PDF, not IPP raster).
// pub fn is_command_language(l: &str) -> bool {
//     matches!(l, LANG_ZPL | LANG_TSPL | LANG_ESCPOS | LANG_CPCL)
// }

/// One page as a 1-bit image: rows are packed MSB first, a set bit is a black dot.
#[derive(Clone, Debug, PartialEq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Bitmap {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Bitmap, String> {
        if width == 0 || height == 0 {
            return Err("The page rendered as an empty image.".into());
        }
        let b = Bitmap { width, height, data };
        if b.data.len() != b.stride() * height as usize {
            return Err(format!(
                "Rendered page has {} bytes, expected {} for {}x{}.",
                b.data.len(),
                b.stride() * height as usize,
                width,
                height
            ));
        }
        Ok(b)
    }

    /// Bytes per row.
    pub fn stride(&self) -> usize {
        (self.width as usize + 7) / 8
    }

    fn mm(&self, dpi: u32) -> (f64, f64) {
        (self.width as f64 / dpi as f64 * 25.4, self.height as f64 / dpi as f64 * 25.4)
    }
}

/// Encodes all pages for `lang` (one of the command languages). `dpi` is the resolution the pages
/// were rendered at.
pub fn encode(lang: &str, pages: &[Bitmap], dpi: u32) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("There are no pages to print.".into());
    }
    if dpi == 0 {
        return Err("The printer resolution must be above 0 dpi.".into());
    }
    let mut out = Vec::new();
    match lang {
        LANG_ZPL => pages.iter().for_each(|p| zpl(&mut out, p)),
        LANG_TSPL => pages.iter().for_each(|p| tspl(&mut out, p, dpi)),
        LANG_CPCL => pages.iter().for_each(|p| cpcl(&mut out, p, dpi)),
        LANG_ESCPOS => {
            out.extend_from_slice(&[0x1B, 0x40]); // ESC @ : initialise
            pages.iter().for_each(|p| escpos(&mut out, p));
        }
        other => return Err(format!("\"{other}\" is not a printer command language.")),
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// ZPL (Zebra and many compatibles). ^GFA with ASCII hex data.
// ---------------------------------------------------------------------------------------------
fn zpl(out: &mut Vec<u8>, p: &Bitmap) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let total = p.data.len();
    out.extend_from_slice(
        format!("^XA^PW{}^LL{}^LH0,0^FO0,0^GFA,{total},{total},{},", p.width, p.height, p.stride()).as_bytes(),
    );
    for b in &p.data {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 15) as usize]);
    }
    out.extend_from_slice(b"^FS^PQ1^XZ\r\n");
}

// ---------------------------------------------------------------------------------------------
// TSPL / TSPL2 (TSC, Xprinter, many Chinese label printers). In BITMAP data a 0 bit is a black dot.
// ---------------------------------------------------------------------------------------------
fn tspl(out: &mut Vec<u8>, p: &Bitmap, dpi: u32) {
    let (w, h) = p.mm(dpi);
    out.extend_from_slice(
        format!("SIZE {w:.1} mm,{h:.1} mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBITMAP 0,0,{},{},0,", p.stride(), p.height).as_bytes(),
    );
    out.extend(p.data.iter().map(|b| !b));
    out.extend_from_slice(b"\r\nPRINT 1,1\r\n");
}

// ---------------------------------------------------------------------------------------------
// CPCL (Zebra/Brother/Honeywell mobile printers). CG = raw 1 bit graphics, a 1 bit is black.
// ---------------------------------------------------------------------------------------------
fn cpcl(out: &mut Vec<u8>, p: &Bitmap, dpi: u32) {
    out.extend_from_slice(
        format!(
            "! 0 {dpi} {dpi} {h} 1\r\nPAGE-WIDTH {w}\r\nCG {} {h} 0 0 ",
            p.stride(),
            h = p.height,
            w = p.width
        )
        .as_bytes(),
    );
    out.extend_from_slice(&p.data);
    out.extend_from_slice(b"\r\nFORM\r\nPRINT\r\n");
}

// ---------------------------------------------------------------------------------------------
// ESC/POS (receipt printers, many cheap Bluetooth label printers). GS v 0 raster, sent in bands
// because some printers reject tall images.
// ---------------------------------------------------------------------------------------------
fn escpos(out: &mut Vec<u8>, p: &Bitmap) {
    const BAND: usize = 128;
    let stride = p.stride();
    for band in p.data.chunks(stride * BAND) {
        let rows = band.len() / stride;
        out.extend_from_slice(&[0x1D, 0x76, 0x30, 0x00]);
        out.extend_from_slice(&(stride as u16).to_le_bytes());
        out.extend_from_slice(&(rows as u16).to_le_bytes());
        out.extend_from_slice(band);
    }
    out.extend_from_slice(&[0x1B, 0x64, 0x03]); // feed 3 lines
    out.extend_from_slice(&[0x1D, 0x56, 0x42, 0x00]); // GS V 66 0: feed and partial cut (ignored without a cutter)
}

// ---------------------------------------------------------------------------------------------
// PWG raster (image/pwg-raster): what IPP Everywhere / driverless printers must accept even when
// they have no PDF support. 8-bit sGray, so a black dot is 0x00 and white is 0xFF.
// ---------------------------------------------------------------------------------------------
const PWG_HEADER_LEN: usize = 1796;

fn put_u32(h: &mut [u8], offset: usize, v: u32) {
    h[offset..offset + 4].copy_from_slice(&v.to_be_bytes());
}

fn pwg_header(p: &Bitmap, dpi: u32) -> Vec<u8> {
    let mut h = vec![0u8; PWG_HEADER_LEN];
    h[..9].copy_from_slice(b"PwgRaster");
    put_u32(&mut h, 276, dpi); // HWResolution x
    put_u32(&mut h, 280, dpi); // HWResolution y
    put_u32(&mut h, 340, 1); // NumCopies
    put_u32(&mut h, 352, (p.width as f64 / dpi as f64 * 72.0).round() as u32); // PageSize (points)
    put_u32(&mut h, 356, (p.height as f64 / dpi as f64 * 72.0).round() as u32);
    put_u32(&mut h, 372, p.width); // cupsWidth
    put_u32(&mut h, 376, p.height); // cupsHeight
    put_u32(&mut h, 384, 8); // cupsBitsPerColor
    put_u32(&mut h, 388, 8); // cupsBitsPerPixel
    put_u32(&mut h, 392, p.width); // cupsBytesPerLine
    put_u32(&mut h, 396, 0); // cupsColorOrder: chunked
    put_u32(&mut h, 400, 18); // cupsColorSpace: sGray
    put_u32(&mut h, 420, 1); // cupsNumColors
    h
}

/// PackBits-style compression of one line of 8-bit pixels (PWG raster flavour).
fn pwg_pack_line(line: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < line.len() {
        // run of identical pixels?
        let mut run = 1;
        while i + run < line.len() && run < 128 && line[i + run] == line[i] {
            run += 1;
        }
        if run >= 2 {
            out.push((run - 1) as u8);
            out.push(line[i]);
            i += run;
            continue;
        }
        // literal stretch until the next run of 2+ (max 128 pixels)
        let start = i;
        while i < line.len() && i - start < 128 && !(i + 1 < line.len() && line[i] == line[i + 1]) {
            i += 1;
        }
        let n = i - start;
        out.push((257 - n) as u8); // -(n-1)
        out.extend_from_slice(&line[start..i]);
    }
}

pub fn pwg_raster(pages: &[Bitmap], dpi: u32) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("There are no pages to print.".into());
    }
    if dpi == 0 {
        return Err("The printer resolution must be above 0 dpi.".into());
    }
    let mut out = b"RaS2".to_vec();
    for p in pages {
        out.extend_from_slice(&pwg_header(p, dpi));
        let w = p.width as usize;
        let mut prev: Option<Vec<u8>> = None;
        let mut repeat = 0usize; // extra copies of `prev`
        let flush = |prev: &Option<Vec<u8>>, repeat: usize, out: &mut Vec<u8>| {
            if let Some(line) = prev {
                out.push(repeat as u8);
                pwg_pack_line(line, out);
            }
        };
        for row in p.data.chunks(p.stride()) {
            let line: Vec<u8> = (0..w).map(|x| if row[x / 8] & (0x80 >> (x % 8)) != 0 { 0x00 } else { 0xFF }).collect();
            if prev.as_ref() == Some(&line) && repeat < 255 {
                repeat += 1;
            } else {
                flush(&prev, repeat, &mut out);
                prev = Some(line);
                repeat = 0;
            }
        }
        flush(&prev, repeat, &mut out);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10 wide, 2 high: row 0 = left 3 dots black, row 1 = all white.
    fn sample() -> Bitmap {
        Bitmap::new(10, 2, vec![0b1110_0000, 0, 0, 0]).unwrap()
    }

    #[test]
    fn bitmap_checks_its_size() {
        assert_eq!(sample().stride(), 2);
        assert!(Bitmap::new(10, 2, vec![0; 3]).is_err());
        assert!(Bitmap::new(0, 2, vec![]).is_err());
    }

    #[test]
    fn zpl_has_header_and_hex() {
        let s = String::from_utf8(encode(LANG_ZPL, &[sample()], 203).unwrap()).unwrap();
        assert_eq!(s, "^XA^PW10^LL2^LH0,0^FO0,0^GFA,4,4,2,E0000000^FS^PQ1^XZ\r\n");
    }

    #[test]
    fn tspl_inverts_bits_and_sizes_in_mm() {
        let out = encode(LANG_TSPL, &[sample()], 203).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("SIZE 1.3 mm,0.3 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBITMAP 0,0,2,2,0,"));
        let at = out.windows(11).position(|w| w == b"BITMAP 0,0,").unwrap();
        let data_start = at + b"BITMAP 0,0,2,2,0,".len();
        assert_eq!(&out[data_start..data_start + 4], &[0b0001_1111, 0xFF, 0xFF, 0xFF]);
        assert!(out.ends_with(b"\r\nPRINT 1,1\r\n"));
    }

    #[test]
    fn cpcl_keeps_bits() {
        let out = encode(LANG_CPCL, &[sample()], 203).unwrap();
        let head = b"! 0 203 203 2 1\r\nPAGE-WIDTH 10\r\nCG 2 2 0 0 ";
        assert!(out.starts_with(head));
        assert_eq!(&out[head.len()..head.len() + 4], &[0b1110_0000, 0, 0, 0]);
        assert!(out.ends_with(b"\r\nFORM\r\nPRINT\r\n"));
    }

    #[test]
    fn escpos_bands_tall_pages() {
        let tall = Bitmap::new(8, 300, vec![0xFF; 300]).unwrap();
        let out = encode(LANG_ESCPOS, &[tall], 203).unwrap();
        assert_eq!(&out[..2], &[0x1B, 0x40]);
        // first band: 128 rows, 1 byte wide
        assert_eq!(&out[2..10], &[0x1D, 0x76, 0x30, 0x00, 1, 0, 128, 0]);
        // 3 bands: 128 + 128 + 44 rows
        let bands = out.windows(4).filter(|w| *w == [0x1D, 0x76, 0x30, 0x00]).count();
        assert_eq!(bands, 3);
        assert!(out.ends_with(&[0x1D, 0x56, 0x42, 0x00]));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(encode(LANG_ZPL, &[], 203).is_err());
        assert!(encode(LANG_ZPL, &[sample()], 0).is_err());
        assert!(encode("pdf", &[sample()], 203).is_err());
        assert!(pwg_raster(&[], 300).is_err());
    }

    /// Reference decoder for the PWG flavour of PackBits, used to check the encoder.
    fn unpack(data: &[u8], width: usize, height: usize) -> Vec<Vec<u8>> {
        let mut i = 0;
        let mut rows = Vec::new();
        while rows.len() < height {
            let repeat = data[i] as usize + 1;
            i += 1;
            let mut line = Vec::new();
            while line.len() < width {
                let c = data[i];
                i += 1;
                if c < 128 {
                    line.extend(std::iter::repeat(data[i]).take(c as usize + 1));
                    i += 1;
                } else {
                    let n = 257 - c as usize;
                    line.extend_from_slice(&data[i..i + n]);
                    i += n;
                }
            }
            assert_eq!(line.len(), width);
            for _ in 0..repeat {
                rows.push(line.clone());
            }
        }
        assert_eq!(i, data.len(), "trailing bytes");
        rows
    }

    #[test]
    fn pwg_raster_round_trips() {
        // a 300 wide page with a noisy first row, then 600 identical white rows (needs 3 repeat chunks)
        let width = 300u32;
        let stride = 38;
        let mut data = vec![0u8; stride * 601];
        for (i, b) in data[..stride].iter_mut().enumerate() {
            *b = if i % 3 == 0 { 0b1010_1010 } else { 0xFF };
        }
        let page = Bitmap::new(width, 601, data.clone()).unwrap();
        let out = pwg_raster(&[page.clone()], 300).unwrap();

        assert_eq!(&out[..4], b"RaS2");
        let h = &out[4..4 + PWG_HEADER_LEN];
        assert_eq!(&h[..9], b"PwgRaster");
        let be = |o: usize| u32::from_be_bytes(h[o..o + 4].try_into().unwrap());
        assert_eq!((be(276), be(372), be(376), be(388), be(392), be(400)), (300, 300, 601, 8, 300, 18));
        assert_eq!((be(352), be(356)), (72, 144)); // 300 px / 300 dpi = 1 in = 72 pt; 601 px ~ 144 pt

        let rows = unpack(&out[4 + PWG_HEADER_LEN..], 300, 601);
        for (y, row) in rows.iter().enumerate() {
            for (x, px) in row.iter().enumerate() {
                let black = data[y * stride + x / 8] & (0x80 >> (x % 8)) != 0;
                assert_eq!(*px, if black { 0 } else { 255 }, "pixel {x},{y}");
            }
        }
    }
}
