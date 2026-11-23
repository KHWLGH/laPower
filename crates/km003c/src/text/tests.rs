// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
use super::*;

#[test]
fn real_epr_text_reserves_spr_positions_and_request_echo_is_not_a_capability() {
    let pdos = parse_pdos("Fixed:5V3A\nFixed:9V3A\nFixed:12V3A\nFixed:15V3A\nFixed:20V5A\nPPS:5-21V5A\nFixed:28V5A\nAVS:15-28V140W");
    assert_eq!(pdos[6].position, 8);
    assert_eq!(pdos[7].position, 9);
    assert!(parse_pdos("req:9000mV,1000mA\nready:8992mV,0mA").is_empty());
    assert_eq!(
        parse_pdos("#7 Fixed 28V5A")[0].position,
        7,
        "explicit nonstandard numbering is preserved"
    );
}

#[test]
fn ufcs_num_indices_are_not_relabelled_as_pd_pps() {
    let pdos = parse_pdos("NUM1 3.40-11.00V 0.50-3.00A\nNUM3 5.00-20.00V 0.50-5.00A");
    assert_eq!(
        pdos.iter().map(|p| p.position).collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert!(pdos
        .iter()
        .all(|p| p.protocol == "ufcs" && p.kind == "ufcs"));
    assert_eq!(pdos[1].volt_max_mv, 20_000);
}

#[test]
fn parse_fixed_and_pps_lines() {
    let text = "\
[1] Fixed 5.00V 3.00A
[2] Fixed 9.00V 3.00A
[3] PPS 3.30-21.00V 3.00A
ready
";
    let pdos = parse_pdos(text);
    assert_eq!(pdos.len(), 3);
    assert_eq!(pdos[0].position, 1);
    assert_eq!(pdos[0].kind, "fixed");
    assert_eq!(pdos[0].volt_min_mv, 5000);
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[0].cur_ma, Some(3000));
    assert!(!pdos[0].programmable);
    assert_eq!(pdos[2].kind, "pps");
    assert_eq!(pdos[2].volt_min_mv, 3300);
    assert_eq!(pdos[2].volt_max_mv, 21000);
    assert!(pdos[2].programmable);
}

#[test]
fn parse_pdo_prefix_and_obj() {
    let pdos = parse_pdos("PDO1: 5V/3A\nobj=2  12.00V  2.00A  Fixed\n");
    assert_eq!(pdos.len(), 2);
    assert_eq!(pdos[0].position, 1);
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[1].position, 2);
    assert_eq!(pdos[1].volt_max_mv, 12000);
}

#[test]
fn parse_list_skips_failed_protocols() {
    let text = "\
PD : OK
QC2.0 : OK
QC3.0 : OK
FCP : FAIL
AFC : n/a
UFCS : OK
";
    let found = parse_detected_protocols(text);
    let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["pd", "qc", "qc3", "ufcs"]);
}

#[test]
fn parse_spaced_index_and_unnumbered() {
    let pdos = parse_pdos("1  5.00V  3.00A\n2  9.00V  3.00A\nPPS 3.30-21.00V 3.00A\n");
    assert_eq!(pdos.len(), 3);
    assert_eq!(pdos[0].position, 1);
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[1].position, 2);
    assert_eq!(pdos[2].kind, "pps");
    assert_eq!(pdos[2].position, 3);
}

#[test]
fn qc3_not_confused_with_qc2() {
    let found = parse_detected_protocols("QC3.0 : OK\n");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "qc3");
}

#[test]
fn mtk_pe_versions_keep_separate_protocol_identities() {
    for text in [
        "mtkpe:true\nmtkpe2.0:true",
        "MTK PE : OK\nMTK PE 2.0 : OK",
        "MTK PE 1.0 : OK\nMTK PE 2.0 : OK",
    ] {
        let found = parse_detected_protocols(text);
        assert_eq!(
            found.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["pe1", "pe2"],
            "{text}"
        );
    }
    for text in ["mtkpe2.0:true", "MTK PE 2.0 : OK"] {
        let found = parse_detected_protocols(text);
        assert_eq!(found.len(), 1, "{text}");
        assert_eq!(found[0].id, "pe2");
    }
    for negative in ["null", "false", " false 5000mV,0mA"] {
        let found = parse_detected_protocols(&format!("mtkpe:{negative}\nmtkpe2.0:true"));
        assert_eq!(
            found.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["pe2"]
        );
    }
}

#[test]
fn parse_multiple_protocols_on_one_line() {
    let found = parse_detected_protocols("PD QC2.0 QC3.0 FCP AFC UFCS\n");
    let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["pd", "qc3", "qc", "fcp", "afc", "ufcs"]);
}

#[test]
fn parse_concatenated_and_comma_pdos() {
    let a = parse_pdos("5V3A 9V3A 12V3A");
    assert_eq!(a.len(), 3);
    assert_eq!(a[0].volt_max_mv, 5000);
    assert_eq!(a[0].cur_ma, Some(3000));
    assert_eq!(a[1].volt_max_mv, 9000);
    assert_eq!(a[2].volt_max_mv, 12000);
    assert_eq!(a[0].position, 1);
    assert_eq!(a[2].position, 3);

    let b = parse_pdos("5V/3A, 9V/3A, PPS 3.3-21V 3A");
    assert_eq!(b.len(), 3);
    assert_eq!(b[0].kind, "fixed");
    assert_eq!(b[1].volt_max_mv, 9000);
    assert_eq!(b[2].kind, "pps");
    assert_eq!(b[2].volt_min_mv, 3300);
    assert_eq!(b[2].volt_max_mv, 21000);
}

#[test]
fn parse_semicolon_and_mv_units() {
    let pdos = parse_pdos("[1] 5000mV 3000mA; [2] 9.00V 3.00A");
    assert_eq!(pdos.len(), 2);
    assert_eq!(pdos[0].position, 1);
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[0].cur_ma, Some(3000));
    assert_eq!(pdos[1].position, 2);
    assert_eq!(pdos[1].volt_max_mv, 9000);
}

#[test]
fn sanitize_drops_control_and_punct_only_lines() {
    let raw = "ok\npdo:7\u{000b},\u{FFFD}\u{0001}\n,\u{FFFD}\u{0002}\nready:5217mV,0mA";
    let clean = sanitize_trigger_text(raw);
    assert_eq!(clean, "ok\npdo:7\nready:5217mV,0mA");
}

#[test]
fn sanitize_drops_gbk_mojibake_pdo_tail() {
    let raw = "pdo:7\n,劝朄<2芾2惲\nready:5217mV,0mA\nmax power 30W";
    let clean = sanitize_trigger_text(raw);
    assert_eq!(clean, "pdo:7\nready:5217mV,0mA\nmax power 30W");
    assert!(!clean.contains('劝'));
}

#[test]
fn sanitize_clips_inline_cjk_on_pdo_count_line() {
    let raw = "ok\npdo:7,憗\nready:5100mV,0mA\nmax power 100W\npdo:9,憗";
    let clean = sanitize_trigger_text(raw);
    assert_eq!(clean, "ok\npdo:7\nready:5100mV,0mA\nmax power 100W\npdo:9");
    assert!(!clean.contains('憗'));
}

#[test]
fn sanitize_keeps_real_firmware_chinese() {
    let raw = "失败\n就绪\n不支持\n最大功率 100W";
    let clean = sanitize_trigger_text(raw);
    assert_eq!(clean, raw);
}

#[test]
fn normalize_scan_keeps_first_ok_line() {
    let text = "PD\nready\nPD : OK\nQC2.0 : OK\nPD : OK\nFCP : FAIL";
    let norm = normalize_scan_text(text);
    assert_eq!(norm, "PD : OK\nQC2.0 : OK\nFCP : FAIL");
}

#[test]
fn normalize_scan_fallback_when_no_scan_lines() {
    let text = "ok\ncc1 attach\nready";
    assert_eq!(normalize_scan_text(text), text);
}

#[test]
fn normalize_scan_dedupes_repeated_pd_detail_block() {
    let text = "\
starting
bc1.2:true 5216mV,0mA
Apple 2.4A
ufcs:null
vfcp:null
qc2.0:5V,9V,12V
qc3.0:3.6-12V
afc:5V,9V,12V
fcp:5V,9V,12V
scp:22.0W,5.00V-12.00V,0.03A-4.20A
sfcp:null
tfcp:null
pd:
PD3.0:30W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 2.50A
Fixed:    15.00V 2.00A
Fixed:    20.00V 1.50A
PPS: 5.00-11.00V 3.00A
PPS: 5.00-20.00V 1.50A
PD3.0:30W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 2.50A
Fixed:    15.00V 2.00A
Fixed:    20.00V 1.50A
PPS: 5.00-11.00V 3.00A
PPS: 5.00-20.00V 1.50A
done
";
    let norm = normalize_scan_text(text);
    assert_eq!(norm.matches("PD3.0:30W PDO:7").count(), 1);
    assert_eq!(norm.matches("Fixed:").count(), 5);
    assert_eq!(norm.matches("PPS:").count(), 2);
    assert!(norm.contains("qc2.0:5V,9V,12V"));
    assert!(norm.contains("pd:"));
    assert!(norm.contains("done"));
    assert!(norm.contains("starting"));
    // Second identical PD block removed; order preserved.
    let pd_pos = norm.find("PD3.0:30W PDO:7").unwrap();
    let done_pos = norm.find("done").unwrap();
    assert!(pd_pos < done_pos);
}

#[test]
fn sanitize_splits_pd_glued_to_svooc() {
    let clean = sanitize_trigger_text("svooc:PD3.2:60W PDO:7");
    assert_eq!(clean, "svooc:\nPD3.2:60W PDO:7");
}

#[test]
fn parse_pd32_skips_null_and_empty_protocol_fields() {
    for text in [
        "svooc:null\nvooc:null\npd:\nPD3.2:60W PDO:7\n",
        "svooc:\nPD3.2:60W PDO:7\n",
    ] {
        let found = parse_detected_protocols(text);
        let ids: Vec<_> = found.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"pd"), "{text:?}: {ids:?}");
        assert!(!ids.contains(&"vooc"), "{text:?}: {ids:?}");
    }
}

#[test]
fn normalize_scan_moves_pd_off_svooc() {
    let text = "\
starting
bc1.2:true 5100mV,0mA
Apple 2.4A
ufcs:null
vfcp:null
qc2.0:5V,9V,12V
qc3.0:3.6-12V
afc:5V,9V,12V
fcp:5V,9V,12V
scp:25.0W,5.00V-12.00V,0.03A-2.50A
sfcp:null
tfcp:null
svooc:PD3.2:60W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 3.00A
Fixed:    15.00V 3.00A
Fixed:    20.00V 3.00A
AVS: 9-20V3.00A,3.00A
PPS: 5.00-21.00V 3.00A
null
vooc:null
mtkpe:
mtkpe2.0:
pd:
PD3.2:60W PDO:7
Fixed:     5.00V 3.00A
Fixed:     9.00V 3.00A
Fixed:    12.00V 3.00A
Fixed:    15.00V 3.00A
Fixed:    20.00V 3.00A
AVS: 9-20V3.00A,3.00A
PPS: 5.00-21.00V 3.00A
done
";
    let norm = normalize_scan_text(text);
    assert_eq!(norm.matches("PD3.2:60W PDO:7").count(), 1);
    assert_eq!(norm.matches("Fixed:").count(), 5);
    assert_eq!(norm.matches("AVS:").count(), 1);
    assert_eq!(norm.matches("PPS:").count(), 1);
    assert!(norm.contains("svooc:null"));
    assert!(!norm.to_ascii_lowercase().contains("svooc:pd"));
    assert!(norm.contains("pd:"));
    assert!(norm.contains("vooc:null"));
    assert!(norm.contains("done"));
    let pd_label = norm.find("pd:").unwrap();
    let pd_table = norm.find("PD3.2:60W PDO:7").unwrap();
    assert!(pd_label < pd_table);
}

#[test]
fn parse_avs_dual_current_keeps_both_in_label() {
    let pdos = parse_pdos("#6 AVS 9.00-20.00 V 3.00/5.00 A");
    assert_eq!(pdos.len(), 2, "{pdos:?}");
    assert_eq!(pdos[0].position, 6);
    assert_eq!(pdos[1].position, 6);
    assert_eq!(pdos[0].kind, "avs");
    assert_eq!(pdos[0].volt_min_mv, 9000);
    assert_eq!(pdos[0].volt_max_mv, 15_000);
    assert_eq!(pdos[0].cur_ma, Some(3000));
    assert_eq!(pdos[1].volt_min_mv, 15_000);
    assert_eq!(pdos[1].volt_max_mv, 20_000);
    assert_eq!(pdos[1].cur_ma, Some(5000));
    assert!(pdos[0].label.contains("3.00 A"), "{}", pdos[0].label);
    assert!(pdos[1].label.contains("5.00 A"), "{}", pdos[1].label);
}

#[test]
fn spr_avs_text_encodings_preserve_bands_and_physical_positions() {
    for text in [
        "AVS: 9-20V2.95A,4.95A",
        "SPR AVS 9-20V 2.95 / 4.95 A",
        "SPR AVS 9-20V 2.95A / 4.95A",
        "SPR AVS 9-20V 2.95,4.95A",
        "SPR AVS 9-20V 2950mA，4950mA",
        "SA 9-15V@2.95A,15-20V@4.95A",
        "SA 15-20V@4.95A、9-15V@2.95A",
    ] {
        let pdos = parse_pdos(&format!("#5 Fixed 20V4.95A; #6 {text}, PPS 3.3-21V3A"));
        assert_eq!(pdos.len(), 4, "{text}: {pdos:?}");
        assert_eq!(
            pdos.iter()
                .map(|p| (p.position, p.volt_min_mv, p.volt_max_mv, p.cur_ma))
                .collect::<Vec<_>>(),
            [
                (5, 20_000, 20_000, Some(4950)),
                (6, 9000, 15_000, Some(2950)),
                (6, 15_000, 20_000, Some(4950)),
                (7, 3300, 21_000, Some(3000)),
            ],
            "{text}"
        );
    }
    // A single advertised limit applies to its stated range, without
    // inventing a 15–20 V band for a source whose maximum is 15 V.
    for (text, expected) in [
        ("AVS 9-15V2.95A", vec![(9000, 15_000, Some(2950))]),
        ("AVS 9-20V2.95A,0A", vec![(9000, 15_000, Some(2950))]),
        ("AVS 9-20V0A,4.95A", vec![(15_000, 20_000, Some(4950))]),
        ("AVS 12-20V3A", vec![(12_000, 20_000, Some(3000))]),
    ] {
        let pdos = parse_pdos(text);
        assert_eq!(
            pdos.iter()
                .map(|p| (p.volt_min_mv, p.volt_max_mv, p.cur_ma))
                .collect::<Vec<_>>(),
            expected,
            "{text}"
        );
    }
    for text in [
        "AVS 9-20V0A,0A",
        "AVS 9-20V3A,5.01A",
        "AVS 9-20V5.01A,3A",
        "AVS 9-20V3.001A,3A",
    ] {
        let pdos = parse_pdos(&format!("#6 {text}\nPPS 3.3-21V3A"));
        assert_eq!(pdos.len(), 1, "{text}: {pdos:?}");
        assert_eq!(pdos[0].position, 7, "{text}");
        assert_eq!(pdos[0].kind, "pps", "{text}");
    }
}

#[test]
fn pdp_at_vmax_converts_to_current() {
    assert_eq!(pdp_to_current_ma(240, 48_000), Some(5000));
    assert_eq!(pdp_to_current_ma(140, 28_000), Some(5000));
    assert_eq!(pdp_to_current_ma(0, 48_000), None);
    assert_eq!(pdp_to_current_ma(240, 0), None);
    assert_eq!(
        avs_current_ma(Some(5000), Some(3000), None, 20_000),
        Some(5000)
    );
    assert_eq!(avs_current_ma(None, Some(3000), None, 20_000), Some(3000));
    assert_eq!(avs_current_ma(None, None, Some(240), 48_000), Some(5000));
    assert_eq!(
        expand_spr_avs_bands(Some(3000), Some(5000)),
        vec![(9000, 15_000, 3000), (15_000, 20_000, 5000)]
    );
    assert_eq!(
        expand_spr_avs_bands(Some(3000), None),
        vec![(9000, 15_000, 3000)]
    );
    assert!(expand_spr_avs_bands(None, None).is_empty());
    assert!(spr_avs_pdos(6, "spr_avs", Some(5010), Some(3000)).is_empty());
    assert!(spr_avs_pdos(6, "spr_avs", Some(3000), Some(5010)).is_empty());
}

#[test]
fn parse_sa_ea_ef_quick_summaries() {
    let sa = parse_pdos("SA 9-15V@3.0A 15-20V@5.0A");
    assert_eq!(sa.len(), 2, "{sa:?}");
    assert_eq!(sa[0].kind, "spr_avs");
    assert_eq!(sa[0].position, sa[1].position);
    assert_eq!(sa[0].volt_min_mv, 9000);
    assert_eq!(sa[0].volt_max_mv, 15_000);
    assert_eq!(sa[0].cur_ma, Some(3000));
    assert_eq!(sa[1].volt_min_mv, 15_000);
    assert_eq!(sa[1].volt_max_mv, 20_000);
    assert_eq!(sa[1].cur_ma, Some(5000));
    assert!(sa[0].programmable);
    assert!(sa[1].programmable);

    let ea = parse_pdos("EA 15-48V@240W");
    assert_eq!(ea.len(), 1, "{ea:?}");
    assert_eq!(ea[0].kind, "epr_avs");
    assert_eq!(ea[0].volt_min_mv, 15_000);
    assert_eq!(ea[0].volt_max_mv, 48_000);
    assert_eq!(ea[0].cur_ma, Some(5000));
    assert!(ea[0].label.contains("240 W"), "{}", ea[0].label);

    let ef = parse_pdos("EF 28V@5A");
    assert_eq!(ef.len(), 1, "{ef:?}");
    assert_eq!(ef[0].kind, "epr_fixed");
    assert_eq!(ef[0].volt_min_mv, 28_000);
    assert_eq!(ef[0].volt_max_mv, 28_000);
    assert_eq!(ef[0].cur_ma, Some(5000));
    assert!(!ef[0].programmable);
}

#[test]
fn parse_spr_epr_avs_words_and_at_watts() {
    let spr = parse_pdos("SPR AVS: 9.00-20.00V 3.00/5.00A");
    assert_eq!(spr.len(), 2, "{spr:?}");
    assert_eq!(spr[0].kind, "spr_avs");
    assert_eq!(spr[0].position, spr[1].position);
    assert_eq!(spr[0].cur_ma, Some(3000));
    assert_eq!(spr[1].cur_ma, Some(5000));
    assert_eq!(spr[0].volt_max_mv, 15_000);
    assert_eq!(spr[1].volt_max_mv, 20_000);

    let epr = parse_pdos("EPR AVS: 15.00-48.00V 240W");
    assert_eq!(epr.len(), 1, "{epr:?}");
    assert_eq!(epr[0].kind, "epr_avs");
    assert_eq!(epr[0].cur_ma, Some(5000));
    assert_eq!(epr[0].volt_max_mv, 48_000);
}
