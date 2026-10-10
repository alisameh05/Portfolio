# Phase 6 Media and CV contract matrix

This matrix connects the existing OpenAPI operations to provider-neutral
application interfaces. OpenAPI remains the transport source of truth;
generated validators enforce closed request and response shapes in the HTTP
adapters. Every Owner operation first requires a verified Owner session and
scope; mutations additionally require origin and CSRF validation.

| HTTP operation | Module application method | Required inputs | Success | Declared problem outcomes |
| --- | --- | --- | --- | --- |
| `GET /api/owner/v1/media/{mediaId}` | `MediaOwnerApplicationService.getOwnerMediaAggregate` | UUID path; no body or command headers | 200 aggregate view | 400, 401, 403, 404, 429, 500, 503 |
| `POST /api/owner/v1/media/upload-intents` | `MediaOwnerApplicationService.createOwnerMediaUploadIntent` | Idempotency-Key; strict body | 201 upload-intent receipt | 400, 401, 403, 409, 422, 429, 500, 503 |
| `POST /api/owner/v1/media/{mediaId}/commands/record-processing` | `MediaOwnerApplicationService.recordOwnerMediaProcessing` | UUID path; Idempotency-Key; If-Match; strict body | 200 command receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `POST /api/owner/v1/media/{mediaId}/commands/accept` | `MediaOwnerApplicationService.acceptOwnerMediaAsset` | UUID path; Idempotency-Key; If-Match; strict body | 200 command receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `POST /api/owner/v1/media/{mediaId}/commands/reject` | `MediaOwnerApplicationService.rejectOwnerMediaAsset` | UUID path; Idempotency-Key; If-Match; strict body | 200 command receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `GET /api/owner/v1/cv` | `OwnerCvApplicationService.getOwnerCvPortfolio` | no body or command headers | 200 retained portfolio view | 400, 401, 403, 404, 429, 500, 503 |
| `POST /api/owner/v1/cv/versions` | `OwnerCvApplicationService.registerOwnerCvVersion` | Idempotency-Key; If-Match; strict body | 201 registration receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `POST /api/owner/v1/cv/versions/{versionId}/commands/accept` | `OwnerCvApplicationService.acceptOwnerCvVersion` | UUID path; Idempotency-Key; If-Match; no body | 200 command receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `POST /api/owner/v1/cv/versions/{versionId}/commands/activate` | `OwnerCvApplicationService.activateOwnerCvVersion` | UUID path; Idempotency-Key; If-Match; no body | 200 command receipt | 400, 401, 403, 404, 409, 412, 422, 429, 500, 503 |
| `GET /api/v1/cv/current` | `CvPortfolioService.downloadCurrentCv` | locale `en`; disposition `inline` or `attachment`; visitor identity and analytics consent are not required | 200 PDF stream or 307 short-lived location; no-store | 400, 404, 429, 500, 503 |

Media acceptance facts are a separate transaction-aware batch query. Content
consumes complete same-Owner facts and a narrow usage query; delivery
resolution binds an accepted asset to its purpose and locale. CV registration,
acceptance, and activation remain separate commands against the shared
Portfolio root version. All unfinished production services remain fail closed.
