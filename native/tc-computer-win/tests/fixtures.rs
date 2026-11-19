//! Every wire fixture (src/main/server/computer/fixtures/wire) decoded with
//! the generated Rust types and encoded again to the same JSON, as the Swift
//! package's ComputerProtocolTests do: the contract both services take.

use std::path::PathBuf;

use serde_json::Value;
use tc_computer_win::wire::methods::{roundtrip_params, roundtrip_result};
use tc_computer_win::wire::{ComputerError, ComputerNotification, HostNotification};

fn wire_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/main/server/computer/fixtures/wire")
}

/// JSON equal, numbers compared by value (1 and 1.0 are one number).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn method_of(file: &str, suffix: &str) -> String {
    // a variant names its method first (apps.list.tabs, action.run.front): the longest method the name starts with
    let stem = file.trim_end_matches(suffix);
    let methods = tc_computer_win::contract::METHODS.iter().filter(|m| stem == **m || stem.starts_with(&format!("{m}.")));
    methods.max_by_key(|m| m.len()).map_or_else(|| stem.to_string(), |m| m.to_string())
}

#[test]
fn every_wire_fixture_round_trips_through_the_rust_types() {
    let mut checked = 0;
    for entry in std::fs::read_dir(wire_dir()).expect("the fixtures are beside the crate") {
        let path = entry.unwrap().path();
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        let frame: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let (given, back) = if file.ends_with(".request.json") {
            let m = method_of(&file, ".request.json");
            let p = frame["params"].clone();
            (p.clone(), roundtrip_params(&m, p).unwrap_or_else(|e| panic!("{file}: {e}")))
        } else if file.ends_with(".response.json") {
            let m = method_of(&file, ".response.json");
            let r = frame["result"].clone();
            (r.clone(), roundtrip_result(&m, r).unwrap_or_else(|e| panic!("{file}: {e}")))
        } else if file.starts_with("error-") {
            if let Some(data) = frame.pointer("/error/data") {
                let e: ComputerError = serde_json::from_value(data.clone()).unwrap_or_else(|e| panic!("{file}: {e}"));
                (data.clone(), serde_json::to_value(e).unwrap())
            } else {
                let r = frame["result"].clone();
                (r.clone(), roundtrip_result("action.run", r).unwrap_or_else(|e| panic!("{file}: {e}")))
            }
        } else if file.starts_with("notify-") {
            let note = serde_json::json!({ "method": frame["method"], "params": frame["params"] });
            let back = match serde_json::from_value::<ComputerNotification>(note.clone()) {
                Ok(n) => serde_json::to_value(n).unwrap(),
                Err(_) => serde_json::to_value(serde_json::from_value::<HostNotification>(note.clone()).unwrap_or_else(|e| panic!("{file}: {e}"))).unwrap(),
            };
            (note, back)
        } else {
            continue;
        };
        assert!(same(&given, &back), "{file} changed in the round trip:\n{given}\n{back}");
        checked += 1;
    }
    assert!(checked > 80, "only {checked} fixtures");
}
