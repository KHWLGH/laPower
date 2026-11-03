//! Small error plumbing shared by the Windows backend modules.
//!
//! A raw HRESULT is never the whole story, so the caller supplies the operation and the message
//! travels to the IPC layer as a diagnostic string that the frontend translates by error code.

/// Diagnostic failure. The IPC layer maps it onto a stable error code, so no user-visible text is
/// produced here: the frontend owns the translation.
#[derive(Debug)]
pub(super) struct Failure(pub(super) String);

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self(message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self(message.to_owned())
    }
}

impl From<windows::core::Error> for Failure {
    fn from(error: windows::core::Error) -> Self {
        Self(format!("windows error 0x{:08X}: {error}", error.code().0))
    }
}

pub(super) type Result<T> = std::result::Result<T, Failure>;

/// Attach an operation name to a Windows error without pulling an error-reporting crate in.
pub(super) trait Context<T> {
    fn ctx(self, message: &str) -> Result<T>;
    fn ctx_with(self, message: impl FnOnce() -> String) -> Result<T>;
}

impl<T, E: Into<Failure>> Context<T> for std::result::Result<T, E> {
    fn ctx(self, message: &str) -> Result<T> {
        self.map_err(|error| Failure(format!("{message}: {}", error.into())))
    }
    fn ctx_with(self, message: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|error| Failure(format!("{}: {}", message(), error.into())))
    }
}

impl<T> Context<T> for Option<T> {
    fn ctx(self, message: &str) -> Result<T> {
        self.ok_or_else(|| Failure(message.to_owned()))
    }
    fn ctx_with(self, message: impl FnOnce() -> String) -> Result<T> {
        self.ok_or_else(|| Failure(message()))
    }
}
