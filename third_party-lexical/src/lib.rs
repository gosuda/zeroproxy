//! A narrow stand-in for the `lexical` crate, version 6: [`parse`] and nothing else.
//!
//! Every release of `lexical` below 7 (and `lexical-core` below 1.0) carries soundness advisories (GHSA-c2hm-mjxv-89r4, GHSA-2326-pfpj-vx3h), and `swc_css_parser`, the only crate in
//! the workspace that uses it, requires `^6.1`. It calls `lexical::parse` to turn the text of a CSS number or an `An+B` offset, which its tokenizer has already checked, into a
//! number. The standard library parses the same text, without `unsafe`, so this crate does that and the unsound code is no longer built. `[patch.crates-io]` in the workspace
//! manifest points `lexical` here.
//!
//! The numbers it is given are plain decimals (`-.5`, `1.5e+3`, `+7`), for which `str::parse` and lexical agree; the tests below pin the shapes the tokenizer produces.
#![no_std]

use core::fmt;
use core::num::IntErrorKind;
use core::str::FromStr;

/// Why a parse failed. Only `Debug` is relied on by callers (they `unreachable!` on it, after the tokenizer has validated the text).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The bytes are not UTF-8, so they are not a number.
    InvalidUtf8,
    /// The text is not a number of the requested type (empty, a stray character, out of range for an integer).
    InvalidNumber,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidUtf8 => f.write_str("invalid utf-8 in a number"),
            Error::InvalidNumber => f.write_str("invalid number"),
        }
    }
}

/// The numeric types [`parse`] can produce (the ones `swc_css_parser` asks for, and their neighbours).
pub trait FromLexical: Sized {
    fn from_lexical(text: &str) -> Result<Self, Error>;
}

macro_rules! from_lexical_float {
    ($($t:ty),*) => {$(
        impl FromLexical for $t {
            fn from_lexical(text: &str) -> Result<Self, Error> {
                <$t as FromStr>::from_str(text).map_err(|_| Error::InvalidNumber)
            }
        }
    )*};
}
from_lexical_float!(f32, f64);

// A run of digits that does not fit the type is clamped to its range, as CSS clamps an integer. lexical 6 wrapped it (`6255912584` parsed as an `i32` gave 1960945288), which is
// a wrong number, and an error would be worse for the one caller: `swc_css_parser` answers an error with `unreachable!`, so a page's `:nth-child(99999999999n)` would panic the
// stylesheet rewrite.
macro_rules! from_lexical_int {
    ($($t:ty),*) => {$(
        impl FromLexical for $t {
            fn from_lexical(text: &str) -> Result<Self, Error> {
                match <$t as FromStr>::from_str(text) {
                    Ok(n) => Ok(n),
                    Err(e) => match e.kind() {
                        IntErrorKind::PosOverflow => Ok(<$t>::MAX),
                        IntErrorKind::NegOverflow => Ok(<$t>::MIN),
                        _ => Err(Error::InvalidNumber),
                    },
                }
            }
        }
    )*};
}
from_lexical_int!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

/// Parse the whole of `bytes` as a number, as `lexical::parse` does.
pub fn parse<N: FromLexical, Bytes: AsRef<[u8]>>(bytes: Bytes) -> Result<N, Error> {
    let text = core::str::from_utf8(bytes.as_ref()).map_err(|_| Error::InvalidUtf8)?;
    N::from_lexical(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_number_shapes_parse_as_the_tokenizer_writes_them() {
        for (text, want) in [
            ("0", 0.0), ("7", 7.0), ("-7", -7.0), ("+7", 7.0), ("1.5", 1.5), (".5", 0.5), ("-.5", -0.5), ("5.", 5.0),
            ("1e3", 1000.0), ("1E3", 1000.0), ("1.5e+3", 1500.0), ("-1.5e-3", -0.0015), ("0.000001", 0.000001),
            ("123456789012345678901234567890", 1.2345678901234568e29),
        ] {
            assert_eq!(parse::<f64, _>(text), Ok(want), "{text}");
        }
        assert_eq!(parse::<f64, _>("1e999"), Ok(f64::INFINITY));
        assert_eq!(parse::<f64, _>("1e-999"), Ok(0.0));
    }

    #[test]
    fn an_plus_b_offsets_parse_as_integers() {
        assert_eq!(parse::<i32, _>("3"), Ok(3));
        assert_eq!(parse::<i32, _>("+3"), Ok(3));
        assert_eq!(parse::<i32, _>("-3"), Ok(-3));
        assert_eq!(parse::<i32, _>("03"), Ok(3));
        assert_eq!(parse::<i32, _>(b"12".as_slice()), Ok(12));
    }

    #[test]
    fn an_integer_out_of_range_is_clamped_not_wrapped_and_not_an_error() {
        assert_eq!(parse::<i32, _>("2147483647"), Ok(i32::MAX));
        assert_eq!(parse::<i32, _>("2147483648"), Ok(i32::MAX));
        assert_eq!(parse::<i32, _>("6255912584"), Ok(i32::MAX));
        assert_eq!(parse::<i32, _>("+99999999999999999999999"), Ok(i32::MAX));
        assert_eq!(parse::<i32, _>("-2147483649"), Ok(i32::MIN));
        assert_eq!(parse::<i32, _>("-99999999999"), Ok(i32::MIN));
        assert_eq!(parse::<u8, _>("300"), Ok(u8::MAX));
    }

    #[test]
    fn what_is_not_a_number_is_an_error() {
        assert_eq!(parse::<f64, _>(""), Err(Error::InvalidNumber));
        assert_eq!(parse::<f64, _>("1.5px"), Err(Error::InvalidNumber));
        assert_eq!(parse::<i32, _>("1.5"), Err(Error::InvalidNumber));
        assert_eq!(parse::<i32, _>(""), Err(Error::InvalidNumber));
        assert_eq!(parse::<i32, _>("-"), Err(Error::InvalidNumber));
        assert_eq!(parse::<u32, _>("-1"), Err(Error::InvalidNumber));
        assert_eq!(parse::<i32, _>([0xff_u8, 0xfe].as_slice()), Err(Error::InvalidUtf8));
    }
}
