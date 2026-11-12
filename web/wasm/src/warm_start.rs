use jagua_rs::collision_detection::hazards::filter::NoFilter;
use jagua_rs::entities::{InferiorQualityZone, Instance};
use jagua_rs::geometry::{DTransformation, geo_enums::RotationRange, geo_traits::Transformable};
use jagua_rs::io::import::ext_to_int_transformation;
use jagua_rs::probs::spp::entities::{
    SPInstance, SPPlacement, SPProblem, SPSolution, SPStockConstraints,
};
use rand::rngs::Xoshiro256PlusPlus;
use serde::Deserialize;
use sparrow::consts::LBF_SAMPLE_CONFIG;
use sparrow::optimizer::lbf::LBFBuilder;

#[derive(Deserialize)]
pub(crate) struct Input {
    pub stock_length: Option<f32>,
    pub(crate) initial_placement: Option<InitialPlacement>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct InitialPlacement {
    used_length_mm: f32,
    placements: Vec<Placement>,
}

#[derive(Clone, Deserialize)]
struct Placement {
    item_id: usize,
    // Like jagua's exported transformations, angles are in degrees.
    rotation: f32,
    translation: [f32; 2],
}

pub(crate) fn parse(input: &str) -> Result<Input, String> {
    let parsed: Input = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let geometry: serde_json::Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let limit = if geometry["stock_geometry"]["boards"].is_array() {
        10_000_000.0
    } else {
        100_000.0
    };
    if parsed
        .stock_length
        .is_some_and(|length| !length.is_finite() || length <= 0.0 || length > limit)
    {
        return Err("Invalid stock_length".into());
    }
    Ok(parsed)
}

/// Finite rectangular stock uses the same bounded construction path as shaped stock.
pub(crate) fn apply_stock_length(
    mut instance: SPInstance,
    input: &Input,
) -> Result<SPInstance, String> {
    if let Some(length) = input.stock_length {
        if let Some(stock) = &instance.stock_constraints {
            if (stock.max_width - length).abs() > 1e-4 {
                return Err("stock_length must match stock_geometry width".into());
            }
        } else {
            if length
                <= 2.0
                    * instance
                        .base_strip
                        .shape_modify_config
                        .offset
                        .unwrap_or(0.0)
            {
                return Err("Stock length must exceed clearance".into());
            }
            instance.base_strip.set_width(length);
            instance = instance
                .with_stock_constraints(SPStockConstraints {
                    max_width: length,
                    holes: InferiorQualityZone::new(0, vec![]).map_err(|e| e.to_string())?,
                    boards: vec![],
                })
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(instance)
}

pub(crate) fn construct(
    instance: &SPInstance,
    input: &Input,
    rng: Xoshiro256PlusPlus,
) -> Result<Option<SPSolution>, String> {
    let Some(initial) = &input.initial_placement else {
        return Ok(None);
    };
    let used = initial.used_length_mm;
    if !used.is_finite()
        || used
            <= 2.0
                * instance
                    .base_strip
                    .shape_modify_config
                    .offset
                    .unwrap_or(0.0)
        || used
            > instance
                .stock_constraints
                .as_ref()
                .map_or(100_000.0, |stock| stock.max_width)
        || initial.placements.is_empty()
        || initial.placements.len() > instance.total_item_qty()
        || instance
            .stock_constraints
            .as_ref()
            .is_some_and(|stock| used > stock.max_width)
    {
        return Err("Invalid initial placement length or quantity".into());
    }
    let mut prob = SPProblem::new(instance.clone());
    // The previous used length is an optimization result, not a physical stock boundary.
    prob.change_strip_width(
        instance
            .stock_constraints
            .as_ref()
            .map_or(used, |stock| stock.max_width),
    );
    for placement in &initial.placements {
        if placement.item_id >= instance.items.len()
            || prob.item_demand_qtys[placement.item_id] == 0
            || !placement.rotation.is_finite()
            || placement.translation.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid initial placement ID, quantity or transformation".into());
        }
        let item = instance.item(placement.item_id);
        let rotation = placement.rotation.to_radians();
        let matches_angle = |allowed: f32| {
            let delta = (rotation - allowed).rem_euclid(std::f32::consts::TAU);
            delta.min(std::f32::consts::TAU - delta) <= 1e-5
        };
        let allowed = match &item.allowed_rotation {
            RotationRange::None => matches_angle(0.0),
            RotationRange::Discrete(angles) => angles.iter().any(|&angle| matches_angle(angle)),
            RotationRange::Continuous => true,
        };
        if !allowed {
            return Err("Initial placement rotation is not allowed".into());
        }
        let external = DTransformation::new(
            rotation,
            (placement.translation[0], placement.translation[1]),
        );
        let d_transf = ext_to_int_transformation(&external, &item.shape_orig.pre_transform);
        if !d_transf.rotation().is_finite()
            || !d_transf.translation().0.is_finite()
            || !d_transf.translation().1.is_finite()
        {
            return Err("Initial placement transformation overflow".into());
        }
        let shape = item.shape_cd.transform_clone(&d_transf.compose());
        if prob.layout.cde().detect_poly_collision(&shape, &NoFilter) {
            return Err("Initial placement collides with parts or stock boundaries".into());
        }
        prob.place_item(SPPlacement {
            item_id: placement.item_id,
            d_transf,
        });
    }
    if let Some(stock) = &instance.stock_constraints {
        prob.change_strip_width(stock.max_width);
    }
    let builder = LBFBuilder::from_problem(prob, rng, LBF_SAMPLE_CONFIG)
        .construct()
        .map_err(|e| format!("Warm start insertion failed: {e}"))?;
    Ok(Some(builder.prob.save()))
}

#[cfg(test)]
#[path = "warm_start_tests.rs"]
mod tests;
