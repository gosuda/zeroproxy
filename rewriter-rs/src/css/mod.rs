mod replacements;
mod url;

use replacements::{apply_replacements, collect_replacements};

pub(crate) fn rewrite(
    source: &str,
    base_url: &str,
    control_prefix: &str,
) -> Result<String, String> {
    let control_prefix = if control_prefix.is_empty() {
        "/zp/"
    } else {
        control_prefix
    };
    collect_replacements(source, base_url, control_prefix)
        .map(|replacements| apply_replacements(source, replacements))
}
