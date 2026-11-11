# Offline license material inputs

`npm run components:generate` generates both `src/third-party-components.json` and `src/legal-notices.json`.
`npm run components:check` performs the same collection in memory and compares both existing catalogs without writing or downloading anything.
Both commands require the locked Cargo package sources to be present locally and use `--locked --offline` for Cargo metadata and tree queries.

The runtime coverage set is the union of the four existing targets selected by:

```text
cargo tree -p lapower --locked --offline --target TARGET --edges normal,no-proc-macro --prefix none --format {p}
```

Tree results are matched to full Cargo metadata package identities, retaining the package source internally.
The public component schema remains name/version/license; ambiguous same-name/version packages from different sources fail rather than merge.
This is a conservative feature-unified license coverage set, not an exact release compilation-unit graph.
Workspace application/protocol packages, build dependencies, development dependencies and procedural macro subgraphs are excluded.

The collector reads real package license, copyright, copying and notice files, including nested native source notices.
Test, example, benchmark and documentation fixture trees are excluded.
An explicit Cargo `license_file` is supported even when `license` is absent, using `LicenseRef-Cargo-license-file` in the component list.
Paths must stay within their package root after resolving links; invalid UTF-8 is rejected.
Text normalization changes CRLF to LF only. BOMs, whitespace and final-newline state remain intact; SHA-256 covers the entire normalized text.

## Supplemental source registry

`materials.json` records supplemental documents by exact component name, version and Cargo source, plus the four frontend assets.
Each document records its local path, original URL, fixed upstream revision/version, original upstream path and normalized SHA-256.
These files were acquired while implementing the collection, then checked into `licenses/upstream/` or `licenses/authorities/`.
The generator never fetches missing material, substitutes a guessed license template or silently drops an unreviewed branch.

When upstream explicitly incorporates authoritative terms by URL, the original licensing statement and the referenced full terms are both retained.
For the HTML-only OSI and zlib references, `authorities/sources/` preserves the CRLF-normalized source snapshot, and `sourceSnapshot` records its hash.
The associated text files contain the complete referenced license text extracted from the indicated license element or PRE block.
Original authority placeholders remain unfilled; they are not attributed as new component-specific copyright notices.
Each affected component includes a clearly labeled project review document explaining this distinction in the offline reader.

To update supplemental materials, fetch the actual text from the new exact package revision, inspect its licensing scope, save the original text without trimming, update the registry hash and provenance, then regenerate and check both catalogs.
Review notes are project explanations, not additional grants. Every explicit review is also printed by both CLI modes.
Full-text signatures reject obvious pointers, truncated terms and missing AND/WITH terms; they supplement the original material and provenance review and are not an automatic legal determination.

## Native material decisions

- hidapi includes the Rust wrapper MIT document and the bundled hidapi BSD/GPL/original files; `etc/hidapi/LICENSE.txt` is retained as a pointer alongside those full texts.
- aws-lc-sys includes its combined root license, `aws-lc/LICENSE` and `aws-lc/third_party/fiat/LICENSE`.
- OpenH264 uses the `source` feature on the applicable Linux/macOS targets. The Cisco source BSD license and the Rust wrapper's explicit BSD terms are separate. `tests/reference/BINARY_LICENSE` concerns a test Cisco binary and is excluded.
- libdbus-sys currently uses system pkg-config rather than its vendored feature. Cached `vendor/dbus` files are therefore excluded; the collector includes those native notices if the vendored feature is selected in a future runtime set.
- webview2-com-sys 0.38.2 contains loader binaries from Microsoft.Web.WebView2 1.0.3650.58. The registry records the exact NuGet archive URL/hash, Microsoft LICENSE/NOTICE, and hashes for DLL/import/static libraries in x64/x86/arm64. Generation and checking verify all nine local crate binaries against this evidence. The SDK archive and binaries are not checked in here.
- ring and selectors were present in the former metadata-only union but are absent from the corrected current tree set; unused source-cache contents are not treated as shipped runtime components.

## Explicit upstream limitations and choices

- block 0.1.6: fixed upstream commit `47178790cfc9d4a8b092051d8b413b78bd31254a` contains only the MIT declaration in Cargo.toml and no independent license/copyright text. The unmerged upstream license PR is evidence of the gap, not an effective grant. This exact-version/source reviewed limitation remains visible in the catalog. No MIT template is presented as its missing upstream license.
- dunce 1.0.5: the fixed source declares `CC0-1.0 OR MIT-0 OR Apache-2.0` and supplies the full CC0 license only. The registry explicitly selects that supplied CC0 alternative, retains the declared expression, and explains the absent alternative documents in the catalog.
- objc2 and related packages: the exact upstream LICENSE.md, including its Apple SDK caveat, is retained together with its explicitly referenced authoritative terms. Upstream does not provide independent copyright lines for those current package texts; no author/year is invented.
- malloc_buf 0.0.6: the version tag has no license file. The registry retains the real MIT license that upstream later added in commit `d9a3e539642bd90e07df458d226b19cdfa606863`, clearly recording that later provenance.
