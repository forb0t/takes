//! Text files (lyrics, notes, track lists) in whatever encoding they came.

/// Windows-1251 bytes 0x80–0xBF; 0xC0–0xFF are А–я in order.
const CP1251_HIGH: [char; 64] = [
    'Ђ', 'Ѓ', '‚', 'ѓ', '„', '…', '†', '‡', '€', '‰', 'Љ', '‹', 'Њ', 'Ќ', 'Ћ', 'Џ', //
    'ђ', '‘', '’', '“', '”', '•', '–', '—', '\u{98}', '™', 'љ', '›', 'њ', 'ќ', 'ћ', 'џ', //
    '\u{a0}', 'Ў', 'ў', 'Ј', '¤', 'Ґ', '¦', '§', 'Ё', '©', 'Є', '«', '¬', '\u{ad}', '®',
    'Ї', //
    '°', '±', 'І', 'і', 'ґ', 'µ', '¶', '·', 'ё', '№', 'є', '»', 'ј', 'Ѕ', 'ѕ', 'ї', //
];

fn cp1251(byte: u8) -> char {
    match byte {
        0..=0x7f => char::from(byte),
        0x80..=0xbf => CP1251_HIGH[usize::from(byte - 0x80)],
        _ => char::from_u32(0x410 + u32::from(byte - 0xc0)).expect("Cyrillic letters"),
    }
}

/// The text of a file, guessing the encoding: UTF-8, UTF-16 with a byte
/// order mark, else Windows-1251 (older Russian lyrics and notes). `None`
/// for binary data.
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return Some(String::from_utf8_lossy(rest).into_owned());
    }
    for (bom, little) in [([0xff, 0xfe], true), ([0xfe, 0xff], false)] {
        if let Some(rest) = bytes.strip_prefix(&bom) {
            let units = rest.as_chunks::<2>().0.iter().map(|&pair| {
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            });
            return Some(
                char::decode_utf16(units)
                    .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                    .collect(),
            );
        }
    }
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text.to_owned()),
        // Only the last character is cut (a shortened preview): still UTF-8.
        Err(e) if e.error_len().is_none() => Some(String::from_utf8_lossy(bytes).into_owned()),
        Err(_) => Some(bytes.iter().map(|&b| cp1251(b)).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings() {
        assert_eq!(decode_text("Ночь, ё".as_bytes()).unwrap(), "Ночь, ё");
        // "Привет, ёлка №1" in Windows-1251.
        let cp = [
            0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x2c, 0x20, 0xb8, 0xeb, 0xea, 0xe0, 0x20, 0xb9,
            0x31,
        ];
        assert_eq!(decode_text(&cp).unwrap(), "Привет, ёлка №1");
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend("Да".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text(&utf16).unwrap(), "Да");
        assert_eq!(decode_text(b"\xef\xbb\xbfhi").unwrap(), "hi");
        // A preview cut in the middle of "я".
        assert_eq!(decode_text(&"оя".as_bytes()[..3]).unwrap(), "о\u{fffd}");
        assert_eq!(decode_text(b"RIFF\0\0\0\0WAVE"), None);
    }
}
