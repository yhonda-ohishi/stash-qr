//! ID の発行と正規化。すべて Crockford base32 (0-9 と I/L/O/U を除く英大文字)。
//!
//! コンテナ ID はラベルに印字して人が読み書きするので 6 桁。手入力の揺れは
//! Crockford の規則どおり吸収する (小文字 → 大文字、I/L → 1、O → 0、`-` は無視)。
//! 内部の行 (movements・item_types など) は衝突を気にしなくてよい 16 桁。

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const CONTAINER_ID_LEN: usize = 6;
pub const ROW_ID_LEN: usize = 16;

/// 乱数から `len` 桁の ID を作る。256 は 32 で割り切れるので `& 31` に偏りは無い。
pub fn new_id(len: usize) -> String {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).expect("getrandom");
    encode(&buf)
}

fn encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| ALPHABET[(b & 31) as usize] as char)
        .collect()
}

/// 人が入力・スキャンしたコンテナ ID を正規形にする。形として有り得なければ `None`。
pub fn normalize_container_id(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(CONTAINER_ID_LEN);
    for c in raw.chars() {
        let c = match c.to_ascii_uppercase() {
            '-' => continue,
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        };
        if !c.is_ascii() || !ALPHABET.contains(&(c as u8)) {
            return None;
        }
        out.push(c);
    }
    (out.len() == CONTAINER_ID_LEN).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_uses_low_five_bits() {
        assert_eq!(encode(&[0, 31, 32, 255, 10, 17]), "0Z0ZAH");
    }

    #[test]
    fn new_id_has_requested_length_and_alphabet() {
        let id = new_id(CONTAINER_ID_LEN);
        assert_eq!(id.len(), CONTAINER_ID_LEN);
        assert!(normalize_container_id(&id).as_deref() == Some(id.as_str()));
    }

    #[test]
    fn normalize_absorbs_crockford_ambiguity() {
        assert_eq!(normalize_container_id("ab-c1o0").as_deref(), Some("ABC100"));
        assert_eq!(normalize_container_id("iLo9zz").as_deref(), Some("1109ZZ"));
    }

    #[test]
    fn normalize_rejects_bad_shapes() {
        assert_eq!(normalize_container_id("ABCDE"), None); // 短い
        assert_eq!(normalize_container_id("ABCDEFG"), None); // 長い
        assert_eq!(normalize_container_id("ABCDEU"), None); // U は Crockford に無い
        assert_eq!(normalize_container_id("ABCDÉ1"), None); // 非 ASCII
    }
}
