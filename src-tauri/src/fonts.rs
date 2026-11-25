// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Cross-platform system font enumeration for customizable UI/chart fonts.

use crate::app_error::AppError;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SystemFontFace {
    pub weight: u16,
    pub italic: bool,
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SystemFontInfo {
    pub family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zh_cn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zh_tw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ja: Option<String>,
    pub has_cjk: bool,
    pub has_ja: bool,
    pub has_latin: bool,
    pub faces: Vec<SystemFontFace>,
}

fn backend_error(detail: impl ToString) -> AppError {
    AppError::new("backendFailure", detail.to_string())
}

fn clean_localized(canonical: &str, value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.starts_with('@') && s != canonical)
}

fn push_unique_name(names: &mut Vec<String>, candidate: &str) {
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed.starts_with('@') {
        return;
    }
    if !names.iter().any(|existing| existing == trimmed) {
        names.push(trimmed.to_string());
    }
}

fn build_sorted_faces(
    by_slot: HashMap<(u16, bool), (bool, Vec<String>)>,
    canonical: &str,
) -> Vec<SystemFontFace> {
    let mut faces: Vec<SystemFontFace> = by_slot
        .into_iter()
        .filter_map(|((weight, italic), (_, names))| {
            (!names.is_empty()).then_some(SystemFontFace {
                weight,
                italic,
                names,
            })
        })
        .collect();
    if faces.is_empty() {
        faces.push(SystemFontFace {
            weight: 400,
            italic: false,
            names: vec![canonical.to_string()],
        });
    }
    faces.sort_by_key(|face| (face.italic, face.weight));
    faces
}

fn record_face_slot(
    by_slot: &mut HashMap<(u16, bool), (bool, Vec<String>)>,
    weight: u16,
    italic: bool,
    is_normal_stretch: bool,
    names: Vec<String>,
) {
    if names.is_empty() {
        return;
    }
    match by_slot.get_mut(&(weight, italic)) {
        Some((existing_normal, existing_names)) => {
            if !*existing_normal && is_normal_stretch {
                *existing_normal = true;
                *existing_names = names;
            } else if *existing_normal == is_normal_stretch {
                for name in names {
                    push_unique_name(existing_names, &name);
                }
            }
        }
        None => {
            by_slot.insert((weight, italic), (is_normal_stretch, names));
        }
    }
}

fn merge_faces(target: &mut Vec<SystemFontFace>, incoming: Vec<SystemFontFace>) {
    for face in incoming {
        if face.names.is_empty() {
            continue;
        }
        if let Some(existing) = target
            .iter_mut()
            .find(|item| item.weight == face.weight && item.italic == face.italic)
        {
            for name in face.names {
                push_unique_name(&mut existing.names, &name);
            }
        } else {
            target.push(face);
        }
    }
    target.sort_by_key(|face| (face.italic, face.weight));
}

fn insert_or_merge(map: &mut HashMap<String, SystemFontInfo>, info: SystemFontInfo) {
    let key = info.family.to_ascii_lowercase();
    match map.get_mut(&key) {
        Some(existing) => {
            existing.has_cjk |= info.has_cjk;
            existing.has_ja |= info.has_ja;
            existing.has_latin |= info.has_latin;
            if existing.zh_cn.is_none() {
                existing.zh_cn = info.zh_cn;
            }
            if existing.zh_tw.is_none() {
                existing.zh_tw = info.zh_tw;
            }
            if existing.ja.is_none() {
                existing.ja = info.ja;
            }
            merge_faces(&mut existing.faces, info.faces);
        }
        None => {
            map.insert(key, info);
        }
    }
}

fn finalize_fonts(map: HashMap<String, SystemFontInfo>) -> Vec<SystemFontInfo> {
    let mut fonts: Vec<SystemFontInfo> = map
        .into_values()
        .filter(|item| item.has_cjk || item.has_ja || item.has_latin)
        .collect();
    fonts.sort_by(|a, b| {
        a.family
            .to_ascii_lowercase()
            .cmp(&b.family.to_ascii_lowercase())
            .then_with(|| a.family.cmp(&b.family))
    });
    fonts
}

#[cfg(target_os = "windows")]
fn read_dwrite_string(
    names: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings,
    index: u32,
) -> Option<String> {
    unsafe {
        let len = names.GetStringLength(index).ok()?;
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        names.GetString(index, &mut buf).ok()?;
        let text = String::from_utf16_lossy(&buf[..len as usize]);
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

#[cfg(target_os = "windows")]
fn find_dwrite_locale(
    names: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings,
    locales: &[&str],
) -> Option<String> {
    use windows::core::{BOOL, HSTRING};

    for locale in locales {
        unsafe {
            let mut index = 0u32;
            let mut exists = BOOL(0);
            if names
                .FindLocaleName(&HSTRING::from(*locale), &mut index, &mut exists)
                .is_ok()
                && exists.as_bool()
            {
                if let Some(value) = read_dwrite_string(names, index) {
                    return Some(value);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn dwrite_has_char(font: &windows::Win32::Graphics::DirectWrite::IDWriteFont, ch: char) -> bool {
    unsafe {
        font.HasCharacter(ch as u32)
            .map(|exists| exists.as_bool())
            .unwrap_or(false)
    }
}

#[cfg(target_os = "windows")]
fn collect_dwrite_info_names(
    font: &windows::Win32::Graphics::DirectWrite::IDWriteFont,
    id: windows::Win32::Graphics::DirectWrite::DWRITE_INFORMATIONAL_STRING_ID,
    out: &mut Vec<String>,
) {
    use windows::core::BOOL;
    use windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings;

    unsafe {
        let mut strings: Option<IDWriteLocalizedStrings> = None;
        let mut exists = BOOL(0);
        if font
            .GetInformationalStrings(id, &mut strings, &mut exists)
            .is_ok()
            && exists.as_bool()
        {
            if let Some(names) = strings {
                if let Some(en) = find_dwrite_locale(&names, &["en-us"]) {
                    push_unique_name(out, &en);
                }
                let count = names.GetCount();
                for idx in 0..count {
                    if let Some(value) = read_dwrite_string(&names, idx) {
                        push_unique_name(out, &value);
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn enumerate_windows() -> Result<Vec<SystemFontInfo>, AppError> {
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
        DWRITE_FONT_SIMULATIONS_NONE, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_WEIGHT_REGULAR, DWRITE_INFORMATIONAL_STRING_FULL_NAME,
        DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME,
    };

    unsafe {
        let factory: IDWriteFactory =
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).map_err(backend_error)?;
        let mut collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .map_err(backend_error)?;
        let collection = collection
            .ok_or_else(|| backend_error("DirectWrite system font collection missing"))?;

        let count = collection.GetFontFamilyCount();
        let mut map: HashMap<String, SystemFontInfo> = HashMap::new();

        for i in 0..count {
            let Ok(family) = collection.GetFontFamily(i) else {
                continue;
            };
            let Ok(names) = family.GetFamilyNames() else {
                continue;
            };
            let canonical = find_dwrite_locale(&names, &["en-us"]).or_else(|| {
                let n = names.GetCount();
                (0..n).find_map(|idx| read_dwrite_string(&names, idx))
            });
            let Some(canonical) = canonical else {
                continue;
            };
            if canonical.is_empty() || canonical.starts_with('@') {
                continue;
            }

            let font = family
                .GetFirstMatchingFont(
                    DWRITE_FONT_WEIGHT_REGULAR,
                    DWRITE_FONT_STRETCH_NORMAL,
                    DWRITE_FONT_STYLE_NORMAL,
                )
                .or_else(|_| family.GetFont(0));
            let Ok(font) = font else {
                continue;
            };

            let has_cjk = dwrite_has_char(&font, '中')
                && (dwrite_has_char(&font, '文')
                    || dwrite_has_char(&font, '电')
                    || dwrite_has_char(&font, '電'));
            let has_ja = dwrite_has_char(&font, 'あ')
                && dwrite_has_char(&font, 'ア')
                && (dwrite_has_char(&font, '電')
                    || dwrite_has_char(&font, '中')
                    || dwrite_has_char(&font, '文'));
            let has_latin = dwrite_has_char(&font, 'A')
                && dwrite_has_char(&font, 'a')
                && dwrite_has_char(&font, '0')
                && dwrite_has_char(&font, '9');
            if !has_cjk && !has_ja && !has_latin {
                continue;
            }

            let font_count = family.GetFontCount();
            let mut real_slots: HashMap<(u16, bool), (bool, Vec<String>)> = HashMap::new();
            let mut sim_slots: HashMap<(u16, bool), (bool, Vec<String>)> = HashMap::new();
            for face_idx in 0..font_count {
                let Ok(face) = family.GetFont(face_idx) else {
                    continue;
                };
                let weight = (face.GetWeight().0.clamp(100, 900)) as u16;
                let italic = face.GetStyle() != DWRITE_FONT_STYLE_NORMAL;
                let is_normal_stretch = face.GetStretch() == DWRITE_FONT_STRETCH_NORMAL;
                let is_simulated = face.GetSimulations() != DWRITE_FONT_SIMULATIONS_NONE;
                let mut face_names = Vec::new();
                collect_dwrite_info_names(
                    &face,
                    DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME,
                    &mut face_names,
                );
                collect_dwrite_info_names(
                    &face,
                    DWRITE_INFORMATIONAL_STRING_FULL_NAME,
                    &mut face_names,
                );
                if weight == 400 && !italic {
                    push_unique_name(&mut face_names, &canonical);
                }
                let target_slots = if is_simulated {
                    &mut sim_slots
                } else {
                    &mut real_slots
                };
                record_face_slot(target_slots, weight, italic, is_normal_stretch, face_names);
            }
            let faces = build_sorted_faces(
                if real_slots.is_empty() {
                    sim_slots
                } else {
                    real_slots
                },
                &canonical,
            );

            let zh_cn =
                clean_localized(&canonical, find_dwrite_locale(&names, &["zh-cn", "zh-sg"]));
            let zh_tw = clean_localized(
                &canonical,
                find_dwrite_locale(&names, &["zh-tw", "zh-hk", "zh-mo"]),
            );
            let ja = clean_localized(&canonical, find_dwrite_locale(&names, &["ja-jp"]));

            insert_or_merge(
                &mut map,
                SystemFontInfo {
                    family: canonical,
                    zh_cn,
                    zh_tw,
                    ja,
                    has_cjk,
                    has_ja,
                    has_latin,
                    faces,
                },
            );
        }

        Ok(finalize_fonts(map))
    }
}

#[cfg(any(not(windows), test))]
fn enumerate_fontdb() -> Vec<SystemFontInfo> {
    use ab_glyph::{Font, FontRef};

    struct FamilyBucket<'a> {
        canonical: String,
        zh_cn: Option<String>,
        zh_tw: Option<String>,
        ja: Option<String>,
        best_score: (u8, u8, u16),
        best_face: &'a fontdb::FaceInfo,
        all_faces: Vec<&'a fontdb::FaceInfo>,
    }

    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut buckets: HashMap<String, FamilyBucket<'_>> = HashMap::new();

    for face in db.faces() {
        if face.families.is_empty() {
            continue;
        }
        let canonical = face
            .families
            .iter()
            .find(|(_, lang)| *lang == fontdb::Language::English_UnitedStates)
            .or_else(|| face.families.iter().find(|(name, _)| name.is_ascii()))
            .or_else(|| face.families.first())
            .map(|(name, _)| name.trim().to_string());
        let Some(canonical) = canonical else {
            continue;
        };
        if canonical.is_empty() || canonical.starts_with('@') {
            continue;
        }

        let zh_cn = clean_localized(
            &canonical,
            face.families
                .iter()
                .find(|(_, lang)| {
                    matches!(
                        *lang,
                        fontdb::Language::Chinese_PeoplesRepublicOfChina
                            | fontdb::Language::Chinese_Singapore
                    )
                })
                .map(|(name, _)| name.clone()),
        );
        let zh_tw = clean_localized(
            &canonical,
            face.families
                .iter()
                .find(|(_, lang)| {
                    matches!(
                        *lang,
                        fontdb::Language::Chinese_Taiwan
                            | fontdb::Language::Chinese_HongKongSAR
                            | fontdb::Language::Chinese_MacaoSAR
                    )
                })
                .map(|(name, _)| name.clone()),
        );
        let ja = clean_localized(
            &canonical,
            face.families
                .iter()
                .find(|(_, lang)| *lang == fontdb::Language::Japanese_Japan)
                .map(|(name, _)| name.clone()),
        );

        let score = (
            u8::from(face.style != fontdb::Style::Normal),
            u8::from(face.stretch != fontdb::Stretch::Normal),
            face.weight.0.abs_diff(400),
        );
        let key = canonical.to_ascii_lowercase();
        match buckets.get_mut(&key) {
            Some(bucket) => {
                if bucket.zh_cn.is_none() {
                    bucket.zh_cn = zh_cn;
                }
                if bucket.zh_tw.is_none() {
                    bucket.zh_tw = zh_tw;
                }
                if bucket.ja.is_none() {
                    bucket.ja = ja;
                }
                if score < bucket.best_score {
                    bucket.best_score = score;
                    bucket.best_face = face;
                }
                bucket.all_faces.push(face);
            }
            None => {
                buckets.insert(
                    key,
                    FamilyBucket {
                        canonical,
                        zh_cn,
                        zh_tw,
                        ja,
                        best_score: score,
                        best_face: face,
                        all_faces: vec![face],
                    },
                );
            }
        }
    }

    let mut map: HashMap<String, SystemFontInfo> = HashMap::new();
    for bucket in buckets.into_values() {
        let caps = db
            .with_face_data(bucket.best_face.id, |data, index| {
                let font = FontRef::try_from_slice_and_index(data, index).ok()?;
                let has_glyph = |ch: char| font.glyph_id(ch).0 != 0;
                let has_cjk =
                    has_glyph('中') && (has_glyph('文') || has_glyph('电') || has_glyph('電'));
                let has_ja = has_glyph('あ')
                    && has_glyph('ア')
                    && (has_glyph('電') || has_glyph('中') || has_glyph('文'));
                let has_latin =
                    has_glyph('A') && has_glyph('a') && has_glyph('0') && has_glyph('9');
                Some((has_cjk, has_ja, has_latin))
            })
            .flatten();

        let Some((has_cjk, has_ja, has_latin)) = caps else {
            continue;
        };
        if !has_cjk && !has_ja && !has_latin {
            continue;
        }
        let mut by_slot: HashMap<(u16, bool), (bool, Vec<String>)> = HashMap::new();
        for face in bucket.all_faces {
            let weight = face.weight.0.clamp(100, 900);
            let italic = face.style != fontdb::Style::Normal;
            let is_normal_stretch = face.stretch == fontdb::Stretch::Normal;
            let mut face_names = Vec::new();
            push_unique_name(&mut face_names, &face.post_script_name);
            if weight == 400 && !italic {
                push_unique_name(&mut face_names, &bucket.canonical);
            }
            record_face_slot(&mut by_slot, weight, italic, is_normal_stretch, face_names);
        }
        let faces = build_sorted_faces(by_slot, &bucket.canonical);
        insert_or_merge(
            &mut map,
            SystemFontInfo {
                family: bucket.canonical,
                zh_cn: bucket.zh_cn,
                zh_tw: bucket.zh_tw,
                ja: bucket.ja,
                has_cjk,
                has_ja,
                has_latin,
                faces,
            },
        );
    }

    finalize_fonts(map)
}

pub(crate) fn enumerate_system_fonts() -> Result<Vec<SystemFontInfo>, AppError> {
    #[cfg(target_os = "windows")]
    {
        enumerate_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(enumerate_fontdb())
    }
}

/// Enumerate installed system fonts with localized names and CJK/Latin glyph coverage.
#[tauri::command]
pub(crate) async fn list_system_fonts() -> Result<Vec<SystemFontInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(enumerate_system_fonts)
        .await
        .map_err(backend_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn enumerate_system_fonts_returns_unique_valid_entries() {
        let fonts = enumerate_system_fonts().expect("system font enumeration succeeds");
        assert!(!fonts.is_empty(), "expected at least one installed font");
        let mut seen = HashSet::new();
        for font in &fonts {
            assert!(!font.family.is_empty());
            assert!(!font.family.starts_with('@'));
            assert!(font.has_cjk || font.has_ja || font.has_latin);
            assert!(
                !font.faces.is_empty(),
                "expected at least one face for {}",
                font.family
            );
            for face in &font.faces {
                assert!((100..=900).contains(&face.weight));
                assert!(!face.names.is_empty());
            }
            assert!(
                seen.insert(font.family.to_ascii_lowercase()),
                "duplicate font family: {}",
                font.family
            );
        }
        assert!(
            fonts.iter().any(|font| font.has_latin),
            "expected at least one Latin-capable font"
        );
    }

    #[test]
    fn fontdb_fallback_also_enumerates_without_panicking() {
        let fonts = enumerate_fontdb();
        assert!(!fonts.is_empty(), "fontdb should find system fonts");
        for font in &fonts {
            assert!(!font.family.is_empty());
            assert!(!font.family.starts_with('@'));
            assert!(font.has_cjk || font.has_ja || font.has_latin);
            assert!(!font.faces.is_empty());
            for face in &font.faces {
                assert!((100..=900).contains(&face.weight));
                assert!(!face.names.is_empty());
            }
        }
    }
}
