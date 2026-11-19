# Fixture sources

- `hast-complete.json`: https://github.com/googleworkspace/google-docs-hast/blob/5284275337f78e4f0953baa41021cae14e0faf26/e2e/__fixtures__/complete.json
  (commit 5284275 of 2025-11-18). Licence Apache-2.0 (repo LICENSE). A real documents.get response, legacy
  single-tab shape, no suggestions, comments, headers, tabs or chips.
- `google-test-mule.json`: the "Example document dump" on https://developers.google.com/workspace/docs/api/samples/output-json
  (page text CC BY 4.0, code samples Apache-2.0, per the page footer). A real response with `tabs` (includeTabsContent=true).
- `synthetic-review.json`: written by hand for this harness from the field shapes on
  https://developers.google.com/workspace/docs/api/reference/rest/v1/documents (last updated 2026-10-09) and the samples on
  https://developers.google.com/workspace/docs/api/how-tos/suggestions. NOT a captured response: it covers comments with
  commentAnchors, suggestions, two tabs with a child tab, header/footer, person/rich-link/date chips, nested and check lists,
  and a positioned image, which no public capture holds. Indices were set by hand to be self-consistent.
