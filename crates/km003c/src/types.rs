//! Values exchanged with callers: trigger commands, their outcome, and the parsed
//! capability lists. JSON shapes are part of the app's IPC contract.

use serde::{Deserialize, Serialize};

/// One protocol-trigger command, sent to the meter as CDC text.
///
/// Serialized with a `type` tag in snake_case, e.g. `{"type":"pd_req","position":2}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TriggerCommand {
    Entry {
        protocol: String,
    },
    PdPdo,
    PdReq {
        position: u8,
        volt_mv: Option<u32>,
        cur_ma: Option<u32>,
    },
    PdCmd {
        cmd: u8,
    },
    PdData {
        hex: String,
    },
    Qc {
        voltage: String,
    },
    Qc3 {
        volt_mv: u32,
    },
    Qc3Adjust {
        steps: i32,
    },
    Fcp {
        voltage: String,
    },
    Afc {
        voltage: String,
    },
    Sfcp {
        voltage: String,
    },
    Scp {
        volt_mv: u32,
        cur_ma: u32,
    },
    Vfcp {
        volt_mv: u32,
        cur_ma: u32,
    },
    Ufcs {
        req: u8,
        volt_mv: Option<u32>,
        cur_ma: Option<u32>,
    },
    UfcsCmd {
        cmd: u32,
    },
    Reset,
    Raw {
        command: String,
    },
    List {
        plus: bool,
    },
    PdmSet {
        pd_type: u8,
        em: u8,
        sink: u8,
    },
    PdmOpen {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config: Option<PdmConfig>,
    },
    PdmClose,
}

/// A source capability the trigger can request, as the meter reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerPdo {
    #[serde(default = "pd_protocol")]
    pub protocol: String,
    /// 1-based object position; SPR AVS bands share their physical position.
    pub position: u8,
    pub kind: String,
    pub volt_min_mv: u32,
    pub volt_max_mv: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cur_ma: Option<u32>,
    pub label: String,
    pub programmable: bool,
}

fn pd_protocol() -> String {
    "pd".into()
}

/// A measured voltage check, independent of command acknowledgement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoltageVerification {
    pub status: String,
    pub target_mv: u32,
    pub measured_mv: Option<u32>,
    pub sample_count: usize,
    pub detail: String,
}

impl VoltageVerification {
    pub fn unavailable(target_mv: u32, detail: impl Into<String>) -> Self {
        Self {
            status: "unavailable".into(),
            target_mv,
            measured_mv: None,
            sample_count: 0,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TriggerContext {
    pub firmware_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firmware_diagnostic: Option<String>,
    pub pdm_version: Option<String>,
    pub applied_pdm: Option<PdmConfig>,
}

/// A fast-charge protocol the meter's `entry list` scan reported as supported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedProtocol {
    pub id: String,
    pub label: String,
}

/// A missing/failed check must never be presented as charger non-support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionState {
    Supported,
    Unsupported,
    NotChecked,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectionVoltage {
    /// PDO kind, `fixed` / `range` from a scan, or `verified` for a successful 5 V probe.
    pub kind: String,
    pub volt_min_mv: u32,
    pub volt_max_mv: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdRevision {
    pub revision_major: u8,
    pub revision_minor: u8,
    pub version_major: u8,
    pub version_minor: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PdReportedVersion {
    pub major: u8,
    pub minor: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdVersionBasis {
    Pps,
    Epr,
    SprAvs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdVersionInference {
    pub minimum_major: u8,
    pub minimum_minor: u8,
    pub basis: PdVersionBasis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProtocolDetection {
    pub id: String,
    pub label: String,
    pub state: DetectionState,
    /// `scan`, `probe`, or `none`; independent of the support state.
    pub source: String,
    pub detail: String,
    /// Only this protocol's reported capabilities or explicitly verified voltage.
    #[serde(default)]
    pub voltages: Vec<DetectionVoltage>,
    /// Legacy exact USB-PD Revision response accepted from older report producers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pd_revision: Option<PdRevision>,
    /// Explicit PD version label from a completed instrument scan, independent of PDO reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pd_reported_version: Option<PdReportedVersion>,
    /// Lowest PD revision proven by a distinctive advertised PDO capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pd_version_inference: Option<PdVersionInference>,
    /// Stable reason key for localization; detail retains the device's reply.
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VoltageVerification>,
}

/// Also emitted during detection; every snapshot belongs to one command/generation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectionReport {
    pub results: Vec<ProtocolDetection>,
    pub phase: String,
    pub active: Option<String>,
    pub completion: Option<String>,
    pub pdm_version: Option<String>,
    pub fallback_used: bool,
    pub elapsed_ms: u64,
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub context: TriggerContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_verification: Option<VoltageVerification>,
}

/// Sink-emulation settings applied with `pdm set type=..,em=..,sink=..`.
///
/// `pd_type`: 0 auto, 1 PD 3.0, 2 PD 3.1, 3 private PPS. `em` (E-Marker): 0 off,
/// 1 20 V 5 A, 2 50 V 5 A EPR, 3 LA135 6.75 A. `sink`: 0 3 A PPS, 1 5 A PPS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdmConfig {
    pub pd_type: u8,
    pub em: u8,
    pub sink: u8,
}

impl Default for PdmConfig {
    fn default() -> Self {
        Self {
            pd_type: 1,
            em: 1,
            sink: 0,
        }
    }
}

/// What one trigger command produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriggerOutcome {
    pub ok: bool,
    pub message: String,
    pub pdos: Vec<TriggerPdo>,
    pub protocols: Vec<DetectedProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detection: Option<DetectionReport>,
    /// `pdm_required`, `protocol_rejected`, `transport_error` or `cancelled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Session state after the command, authoritative for the UI's PDM indicator.
    pub pdm_open: bool,
    pub context: TriggerContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_verification: Option<VoltageVerification>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_keep_their_snake_case_json_shape() {
        let cmd: TriggerCommand = serde_json::from_value(
            json!({"type": "pd_req", "position": 2, "volt_mv": 9000, "cur_ma": null}),
        )
        .unwrap();
        assert_eq!(
            cmd,
            TriggerCommand::PdReq {
                position: 2,
                volt_mv: Some(9000),
                cur_ma: None
            }
        );
        assert_eq!(
            serde_json::to_value(TriggerCommand::List { plus: true }).unwrap(),
            json!({"type": "list", "plus": true})
        );
        assert_eq!(
            serde_json::to_value(TriggerCommand::PdmOpen { config: None }).unwrap(),
            json!({"type": "pdm_open"})
        );
        assert_eq!(
            serde_json::from_value::<TriggerCommand>(json!({"type": "qc3_adjust", "steps": -1}))
                .unwrap(),
            TriggerCommand::Qc3Adjust { steps: -1 }
        );
    }

    #[test]
    fn outcome_omits_absent_code_and_optional_current() {
        let outcome = TriggerOutcome {
            ok: true,
            message: "ok".into(),
            pdos: vec![TriggerPdo {
                protocol: "pd".into(),
                position: 1,
                kind: "fixed".into(),
                volt_min_mv: 5000,
                volt_max_mv: 5000,
                cur_ma: None,
                label: "#1 FIXED 5.00 V".into(),
                programmable: false,
            }],
            protocols: Vec::new(),
            detection: None,
            code: None,
            pdm_open: true,
            context: TriggerContext::default(),
            reset_verification: None,
        };
        let value = serde_json::to_value(outcome).unwrap();
        assert!(value.get("code").is_none());
        assert!(value["pdos"][0].get("cur_ma").is_none());
        assert_eq!(value["pdm_open"], json!(true));
    }

    #[test]
    fn protocol_detection_preserves_legacy_revision_without_inventing_inference() {
        let legacy = json!({
            "id": "pd",
            "label": "PD",
            "state": "supported",
            "source": "probe",
            "detail": "Fixed: 5.00V 3.00A",
            "voltages": [],
            "pd_revision": {
                "revision_major": 3,
                "revision_minor": 2,
                "version_major": 1,
                "version_minor": 2
            },
            "reason": ""
        });
        let detection: ProtocolDetection = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            detection.pd_revision,
            Some(PdRevision {
                revision_major: 3,
                revision_minor: 2,
                version_major: 1,
                version_minor: 2,
            })
        );
        assert_eq!(detection.pd_version_inference, None);
        assert_eq!(detection.pd_reported_version, None);
        let serialized = serde_json::to_value(detection).unwrap();
        assert_eq!(serialized["pd_revision"]["revision_minor"], json!(2));
        assert!(serialized.get("pd_reported_version").is_none());
        assert!(serialized.get("pd_version_inference").is_none());
    }
}
