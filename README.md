# markdown-to-latex-template

A self-hosted HTTP API that compiles Markdown documents into PDFs using configurable LaTeX templates. Designed as a private compilation service; the caller provides the Markdown body, BibTeX references, template name, and resolved frontmatter metadata, and the API returns a compiled PDF.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18
- [Docker](https://www.docker.com/) (used to run `pandoc/latex` and `texlive/texlive` containers)

## Setup

```bash
npm install        # or pnpm install
cp .env.example .env
# Edit .env and set a strong API_TOKEN
```

## Running

```bash
npm start          # production
npm run dev        # development (auto-restart on file change)
```

The server listens on `http://localhost:3456` by default. Override with `PORT` in `.env`.

## API

### `GET /health`

Returns `{"status":"ok"}`. No authentication required.

### `POST /compile`

Compiles a Markdown document into a PDF.

**Headers**

| Header          | Value                        |
|-----------------|------------------------------|
| `Authorization` | `Bearer <API_TOKEN>`         |
| `Content-Type`  | `multipart/form-data`        |

**Form fields**

| Field    | Type   | Required | Description                                          |
|----------|--------|----------|------------------------------------------------------|
| `data`   | string | Yes      | JSON payload (see schema below)                      |
| `assets` | file   | No       | Image/asset files referenced from the markdown body. Repeat the field for multiple files. |

**`data` JSON schema**

```json
{
  "markdown": "...",
  "references": "...",
  "template": "ieee-conference",
  "appendices": [
    {
      "title": "Tool Calling Sample",
      "markdown": "..."
    }
  ],
  "frontmatter": {
    "title": "My Paper",
    "description": "Abstract fallback.",
    "thanks": "Affiliation footnote.",
    "indexTerms": ["keyword one", "keyword two"],
    "authors": [
      {
        "name": "Jane Doe",
        "department": "Department of Computer Science",
        "organization": "University of Example",
        "city": "Springfield",
        "country": "USA",
        "email": "jane@example.com",
        "orcid": "0000-0000-0000-0000"
      }
    ]
  }
}
```

**Response**

- `200 OK` — `application/pdf` — compiled PDF binary.
- `400 Bad Request` — `{ "error": "..." }` — invalid/missing request fields.
- `401 Unauthorized` — missing or wrong API token.
- `500 Internal Server Error` — `{ "error": "..." }` — compilation failure with details.

## Adding templates

1. Create `templates/<name>/` with your LaTeX entry file and any required `.cls`/`.sty` files.
2. Add a `template.config.json`:
   ```json
   { "entry": "main.tex", "output": "main.pdf" }
   ```
3. Use `{{TITLE}}`, `{{TITLE_THANKS}}`, `{{AUTHORS}}`, `{{ABSTRACT}}`, `{{INDEX_TERMS}}`, `{{BODY_LATEX}}`, and `{{APPENDICES_LATEX}}` placeholders in your entry `.tex` file.

## Environment variables

| Variable    | Default     | Description                          |
|-------------|-------------|--------------------------------------|
| `API_TOKEN` | `changeme`  | Bearer token required on every request |
| `PORT`      | `3456`      | TCP port to listen on                |
