use serde_json::{Value, json};
use usvg::tiny_skia_path::PathSegment;
use wasm_bindgen::prelude::*;

/// Resolve SVG presentation into paths. Studio applies its cutting-outline policy afterwards.
#[wasm_bindgen]
pub fn svg_paths(text: &str) -> Result<String, JsValue> {
    resolve(text)
        .map(|value| value.to_string())
        .map_err(|error| JsValue::from_str(&error))
}

fn resolve(text: &str) -> Result<Value, String> {
    if text.len() > 10 * 1024 * 1024 {
        return Err("SVG exceeds 10 MiB.".into());
    }
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(text, &options).map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    collect(tree.root(), &mut paths)?;
    Ok(json!({"height": tree.size().height(), "paths": paths}))
}

fn collect(
    group: &usvg::Group,
    paths: &mut Vec<Value>,
) -> Result<(), String> {
    if group.opacity().get() == 0.0 {
        return Ok(());
    }
    if group.clip_path().is_some() || group.mask().is_some() || !group.filters().is_empty() {
        return Err("Clipping, masks and filters need conversion to explicit cutting outlines before import.".into());
    }
    for node in group.children() {
        match node {
            usvg::Node::Group(group) => collect(group, paths)?,
            usvg::Node::Path(path) => {
                let filled = path.fill().is_some_and(|fill| fill.opacity().get() > 0.0);
                let stroked = path
                    .stroke()
                    .is_some_and(|stroke| stroke.opacity().get() > 0.0);
                if !path.is_visible() || !(filled || stroked) {
                    continue;
                }
                if paths.len() >= 10_000 {
                    return Err("SVG exceeds 10,000 expanded paths.".into());
                }
                let mut commands = Vec::new();
                for segment in path.data().segments() {
                    commands.push(match segment {
                        PathSegment::MoveTo(p) => json!(["M", p.x, p.y]),
                        PathSegment::LineTo(p) => json!(["L", p.x, p.y]),
                        PathSegment::QuadTo(a, b) => json!(["Q", a.x, a.y, b.x, b.y]),
                        PathSegment::CubicTo(a, b, c) => json!(["C", a.x, a.y, b.x, b.y, c.x, c.y]),
                        PathSegment::Close => json!(["Z"]),
                    });
                }
                let t = path.abs_transform();
                paths.push(json!({
                    "id": path.id(), "commands": commands,
                    "transform": [t.sx, t.ky, t.kx, t.sy, t.tx, t.ty],
                    "rule": if path.fill().is_some_and(|fill| fill.rule() == usvg::FillRule::EvenOdd) { "evenodd" } else { "nonzero" },
                }));
            }
            usvg::Node::Image(_) | usvg::Node::Text(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_more_than_one_hundred_thousand_segments() {
        let mut path = String::from("M0 0");
        for i in 0..100_001 {
            path.push_str(if i % 2 == 0 { "L1 0" } else { "L1 1" });
        }
        path.push('Z');
        let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="{path}"/></svg>"#);
        let value = resolve(&svg).unwrap();
        assert!(value["paths"][0]["commands"].as_array().unwrap().len() > 100_000);
    }
}
