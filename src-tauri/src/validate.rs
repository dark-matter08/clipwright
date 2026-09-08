//! Input validation at the Tauri command boundary.
//!
//! Mirrors the Python-side schema invariants so an out-of-spec value can't
//! slip through the IPC channel and become a CLI argument. Keep these
//! checks tight: any failure here is a programmer error on the TS side
//! (the schema dataclass validates on write), so the error message
//! prioritizes diagnostics over user-friendliness.

/// `seg_id` must match `^seg_[a-z0-9]+$` (matches
/// `clipwright.schema.v1.timeline._SEG_ID_RE`).
///
/// Returns an `Err(String)` describing the problem so each caller can wrap
/// the message into its module-specific error variant.
pub fn seg_id(s: &str) -> Result<(), String> {
    if !s.starts_with("seg_") || s.len() <= 4 {
        return Err(format!(
            "seg_id must match 'seg_<alnum>'; got {:?}",
            truncate(s, 60),
        ));
    }
    if !s[4..]
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(format!(
            "seg_id must match 'seg_<alnum>'; got {:?}",
            truncate(s, 60),
        ));
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_form() {
        assert!(seg_id("seg_001").is_ok());
        assert!(seg_id("seg_002a").is_ok());
        assert!(seg_id("seg_abc123").is_ok());
    }

    #[test]
    fn rejects_bad_prefix() {
        assert!(seg_id("").is_err());
        assert!(seg_id("seg").is_err());
        assert!(seg_id("seg_").is_err());
        assert!(seg_id("clip_001").is_err());
        assert!(seg_id("--force").is_err());
    }

    #[test]
    fn rejects_uppercase_or_punctuation() {
        assert!(seg_id("seg_ABC").is_err());
        assert!(seg_id("seg_001;rm").is_err());
        assert!(seg_id("seg_001 002").is_err());
        assert!(seg_id("seg_../etc").is_err());
    }
}
