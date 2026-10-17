//! Manual GitHub release checks. Nothing in this module runs at startup.
use crate::app_error::AppError;
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;

const REPOSITORY: &str = "https://github.com/KHWLGH/laPower";
const LATEST_RELEASE: &str = "https://api.github.com/repos/KHWLGH/laPower/releases/latest";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateStatus {
    Available,
    Current,
    NoRelease,
}

#[derive(Debug, Serialize)]
pub(crate) struct UpdateCheck {
    status: UpdateStatus,
    current_version: String,
    latest_version: Option<String>,
    tag: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectPage {
    Repository,
    Release,
}

fn release_version(tag: &str) -> Result<Version, AppError> {
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|error| AppError::new("updateInvalidResponse", error.to_string()))?;
    if !version.pre.is_empty() {
        return Err(AppError::new("updateInvalidResponse", "prerelease tag"));
    }
    Ok(version)
}

fn no_release(current: &str) -> UpdateCheck {
    UpdateCheck {
        status: UpdateStatus::NoRelease,
        current_version: current.to_owned(),
        latest_version: None,
        tag: None,
    }
}

fn compare_release(current: &str, release: GitHubRelease) -> Result<UpdateCheck, AppError> {
    if release.draft || release.prerelease {
        return Ok(no_release(current));
    }
    let latest = release_version(&release.tag_name)?;
    let installed = Version::parse(current)
        .map_err(|error| AppError::new("updateInvalidResponse", error.to_string()))?;
    // Build metadata does not change a release's precedence.
    let newer = latest.cmp_precedence(&installed).is_gt();
    Ok(UpdateCheck {
        status: if newer {
            UpdateStatus::Available
        } else {
            UpdateStatus::Current
        },
        current_version: current.to_owned(),
        latest_version: Some(latest.to_string()),
        tag: Some(release.tag_name),
    })
}

fn network_error(error: reqwest::Error) -> AppError {
    AppError::new(
        if error.is_timeout() {
            "updateTimeout"
        } else {
            "updateNetworkError"
        },
        error.to_string(),
    )
}

async fn fetch_release(client: &Client, url: &str, current: &str) -> Result<UpdateCheck, AppError> {
    let mut response = client.get(url).send().await.map_err(network_error)?;
    match response.status() {
        StatusCode::NOT_FOUND => return Ok(no_release(current)),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            return Err(AppError::new(
                "updateRateLimited",
                response.status().to_string(),
            ));
        }
        status if !status.is_success() => {
            return Err(AppError::new("updateServiceError", status.to_string()));
        }
        _ => {}
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::new(
                "updateInvalidResponse",
                "release response too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let release = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("updateInvalidResponse", error.to_string()))?;
    compare_release(current, release)
}

#[tauri::command]
pub(crate) async fn check_for_updates() -> Result<UpdateCheck, AppError> {
    let current = env!("CARGO_PKG_VERSION");
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "Accept",
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        reqwest::header::HeaderValue::from_static("2022-11-28"),
    );
    let client = Client::builder()
        .user_agent(format!("laPower/{current}"))
        .default_headers(headers)
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(network_error)?;
    fetch_release(&client, LATEST_RELEASE, current).await
}

fn project_url(page: ProjectPage, tag: Option<&str>) -> Result<String, AppError> {
    match page {
        ProjectPage::Repository => Ok(REPOSITORY.to_owned()),
        ProjectPage::Release => {
            let tag =
                tag.ok_or_else(|| AppError::new("projectPageError", "missing release tag"))?;
            release_version(tag)
                .map_err(|error| AppError::new("projectPageError", error.to_string()))?;
            Ok(format!("{REPOSITORY}/releases/tag/{tag}"))
        }
    }
}

#[tauri::command]
pub(crate) async fn open_project_page(
    app: tauri::AppHandle,
    page: ProjectPage,
    tag: Option<String>,
) -> Result<(), AppError> {
    let url = project_url(page, tag.as_deref())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::new("projectPageError", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn release(tag: &str) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn compares_semver_instead_of_text_and_ignores_build_metadata() {
        for (current, tag, expected) in [
            ("0.2.4", "v0.2.5", UpdateStatus::Available),
            ("0.2.9", "v0.2.10", UpdateStatus::Available),
            ("0.2.4", "0.2.4", UpdateStatus::Current),
            ("0.3.0", "v0.2.4", UpdateStatus::Current),
            ("0.2.4", "v0.2.4+build.5", UpdateStatus::Current),
        ] {
            assert_eq!(
                compare_release(current, release(tag)).unwrap().status,
                expected
            );
        }
    }

    #[test]
    fn rejects_invalid_tags_and_excludes_nonpublic_releases() {
        for tag in [
            "latest",
            "v1.0.0-beta.1",
            "v1.2.3/../../",
            "https://example.com",
            "v01.2.3",
        ] {
            assert!(compare_release("0.2.4", release(tag)).is_err());
        }
        for (draft, prerelease) in [(true, false), (false, true)] {
            let mut item = release("v1.0.0");
            item.draft = draft;
            item.prerelease = prerelease;
            assert_eq!(
                compare_release("0.2.4", item).unwrap().status,
                UpdateStatus::NoRelease
            );
        }
    }

    #[test]
    fn external_pages_are_fixed_to_the_project() {
        assert_eq!(
            project_url(ProjectPage::Repository, None).unwrap(),
            REPOSITORY
        );
        assert_eq!(
            project_url(ProjectPage::Release, Some("v1.2.3")).unwrap(),
            format!("{REPOSITORY}/releases/tag/v1.2.3")
        );
        assert!(project_url(ProjectPage::Release, None).is_err());
        for tag in [
            "https://example.com",
            "../other",
            "v1.2.3?redirect=evil",
            "v1.2.3-beta",
        ] {
            assert!(project_url(ProjectPage::Release, Some(tag)).is_err());
        }
    }

    fn response(status: &str, body: &str) -> Result<UpdateCheck, AppError> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/release", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let received = stream.read(&mut request).unwrap();
            assert!(
                received > 0,
                "client must send a request before the mock response"
            );
            stream.write_all(reply.as_bytes()).unwrap();
        });
        let result = tauri::async_runtime::block_on(async {
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            fetch_release(&client, &url, "0.2.4").await
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn handles_http_and_invalid_responses_without_claiming_success() {
        assert_eq!(
            response(
                "200 OK",
                r#"{"tag_name":"v0.2.5","draft":false,"prerelease":false}"#
            )
            .unwrap()
            .status,
            UpdateStatus::Available
        );
        assert_eq!(
            response("404 Not Found", "{}").unwrap().status,
            UpdateStatus::NoRelease
        );
        for status in ["403 Forbidden", "429 Too Many Requests"] {
            assert_eq!(
                response(status, "{}").unwrap_err().code,
                "updateRateLimited"
            );
        }
        assert_eq!(
            response("500 Server Error", "{}").unwrap_err().code,
            "updateServiceError"
        );
        assert_eq!(
            response("200 OK", "not json").unwrap_err().code,
            "updateInvalidResponse"
        );
        assert_eq!(
            response("200 OK", "{}").unwrap_err().code,
            "updateInvalidResponse"
        );
    }

    #[test]
    fn distinguishes_timeout_and_connection_failure() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/release", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (_stream, _) = listener.accept().unwrap();
                std::thread::sleep(Duration::from_millis(100));
            });
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(25))
                .build()
                .unwrap();
            assert_eq!(
                fetch_release(&client, &url, "0.2.4")
                    .await
                    .unwrap_err()
                    .code,
                "updateTimeout"
            );
            server.join().unwrap();
            // The listener has closed, so this is a connection error rather than a timeout.
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            assert_eq!(
                fetch_release(&client, &url, "0.2.4")
                    .await
                    .unwrap_err()
                    .code,
                "updateNetworkError"
            );
        });
    }
}
