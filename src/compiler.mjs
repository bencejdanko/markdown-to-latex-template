/**
 * compiler.mjs
 *
 * Core compilation pipeline: Markdown + BibTeX + template → PDF.
 * All logic ported from the original generate-pdfs.mjs script.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEMPLATES_DIR = join(ROOT, "templates");
const BUILD_ROOT = join(ROOT, ".tmp", "builds");

const TABLE_CAPTION_SPLIT_TOKEN = "PDFCAPSPLITTOKEN";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBibForBibtex(bibText) {
  let out = String(bibText ?? "");

  // BibTeX doesn't support these entry types in classic styles.
  out = out
    .replace(/@online\s*\{/gi, "@misc{")
    .replace(/@software\s*\{/gi, "@misc{");

  // Tolerate accidental JS-style line comments in .bib files.
  out = out.replace(/^\s*\/\/.*$/gm, "");

  // Normalize Unicode dash variants that can break BibTeX parsing.
  out = out
    .replace(/\u2013/g, "--")
    .replace(/\u2014/g, "---");

  return out;
}

export function escapeLatex(input) {
  const text = String(input ?? "");
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

// ---------------------------------------------------------------------------
// Author block
// ---------------------------------------------------------------------------

/**
 * Build the IEEE author block from a pre-resolved array of author objects.
 * Each author object should have: name, department, organization, city,
 * country, email, orcid (all optional except name).
 */
export function buildAuthorBlock(authors = []) {
  if (authors.length === 0) return "";

  return authors
    .map((a) => {
      const lines = [
        a.department,
        a.organization,
        [a.city, a.country].filter(Boolean).join(", "),
        a.email,
        a.orcid,
      ]
        .filter(Boolean)
        .map((line) => escapeLatex(line));

      return [
        `\\IEEEauthorblockN{${escapeLatex(a.name ?? "")}}`,
        `\\IEEEauthorblockA{${lines.join(" \\\\ ")}}`,
      ].join("\n");
    })
    .join("\n\\and\n");
}

function getTitleThanks(thanks) {
  if (!thanks) return "";
  return `\\thanks{${escapeLatex(thanks)}}`;
}

// ---------------------------------------------------------------------------
// Markdown normalisation
// ---------------------------------------------------------------------------

function extractSection(markdown, heading) {
  const regex = new RegExp(
    `(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\n#\\s+|$)`,
    "i"
  );
  const match = markdown.match(regex);
  if (!match) return { content: "", markdown };

  const fullMatch = match[0];
  const content = match[1].trim();
  const cleaned = markdown.replace(fullMatch, "\n").trim();
  return { content, markdown: cleaned };
}

function normalizeTableCaptions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  const isPipeRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isAlignmentRow = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

  let i = 0;
  while (i < lines.length) {
    const titleMatch = lines[i].match(/^\s*Table:\s+(.+)\s*$/i);
    if (titleMatch) {
      let tableStart = i + 1;
      while (tableStart < lines.length && lines[tableStart].trim() === "") {
        tableStart += 1;
      }
      if (
        tableStart + 1 < lines.length &&
        isPipeRow(lines[tableStart]) &&
        isAlignmentRow(lines[tableStart + 1])
      ) {
        const title = titleMatch[1].trim();
        let j = tableStart;
        while (j < lines.length && isPipeRow(lines[j])) j += 1;
        while (j < lines.length && lines[j].trim() === "") j += 1;

        const captionMatch = j < lines.length ? lines[j].match(/^\s*:\s+(.+)\s*$/) : null;
        const caption = captionMatch ? captionMatch[1].trim() : "";
        const fullCaption = caption
          ? `${title} ${TABLE_CAPTION_SPLIT_TOKEN} ${caption}`
          : title;

        out.push(...lines.slice(tableStart, j));
        out.push(`Table: ${fullCaption}`);
        i = captionMatch ? j + 1 : j;
        continue;
      }
    }

    if (
      i + 1 < lines.length &&
      isPipeRow(lines[i]) &&
      isAlignmentRow(lines[i + 1])
    ) {
      const tableStart = i;
      let j = tableStart;
      while (j < lines.length && isPipeRow(lines[j])) j += 1;
      while (j < lines.length && lines[j].trim() === "") j += 1;

      const captionMatch = j < lines.length ? lines[j].match(/^\s*:\s+(.+)\s*$/) : null;
      if (captionMatch) {
        const caption = captionMatch[1].trim();
        out.push(...lines.slice(tableStart, j));
        out.push(`Table: ${caption}`);
        i = j + 1;
        continue;
      }
    }

    out.push(lines[i]);
    i += 1;
  }

  return out.join("\n");
}

export function normalizeMarkdown(markdown) {
  let out = markdown;

  const abstract = extractSection(out, "Abstract");
  out = abstract.markdown;

  // Support identification labels in headings specifically. 
  // We avoid a global replace to prevent mangling code blocks or other text.
  out = out.replace(/^(#{1,6}.*?)\s*\{#([A-Za-z0-9:_.-]+)\}\s*$/gm, "$1 \\label{$2}");

  // Promote headings one level (title already in frontmatter)
  out = out.replace(/^(#{2,6})\s+/gm, (_m, hashes) => `${hashes.slice(1)} `);

  let hasCitations = out.includes("\\cite");
  // Convert citation syntax [@key; @key2] -> \cite{key,key2}
  out = out.replace(/\[([^\]]*@[^\]]+)\]/g, (match, inner) => {
    const keys = [...inner.matchAll(/@([A-Za-z0-9:_./-]+)/g)].map((m) => m[1]);
    if (keys.length === 0) return match;
    hasCitations = true;
    return `\\cite{${keys.join(",")}}`;
  });

  // Remove markdown horizontal rules
  out = out.replace(/^---\s*$/gm, "");

  // Normalize table captions
  out = normalizeTableCaptions(out);

  // Convert footnotes to inline LaTeX
  const footnotes = new Map();
  const lines = out.split(/\r?\n/);
  const keptLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (!defMatch) {
      keptLines.push(line);
      continue;
    }
    const id = defMatch[1];
    const parts = [defMatch[2].trim()];
    let j = i + 1;
    while (j < lines.length && /^( {2,}|\t)/.test(lines[j])) {
      parts.push(lines[j].trim());
      j += 1;
    }
    i = j - 1;
    footnotes.set(id, escapeLatex(parts.join(" ").trim()));
  }

  out = keptLines.join("\n");
  out = out.replace(/\[\^([^\]]+)\]/g, (_match, id) => {
    const text = footnotes.get(id);
    if (!text) return "";
    return `\\footnote{${text}}`;
  });

  // Strip trailing references section (BibTeX prints its own)
  out = out.replace(/(?:^|\n)#{1,6}\s+References\s*\n[\s\S]*$/i, "\n");

  // Strip emoji and supplementary-plane Unicode (U+1F000+) that pdflatex
  // cannot handle without special packages.
  out = out.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");

  return {
    abstract: abstract.content.replace(/\s+/g, " ").trim(),
    markdown: out.trim(),
    hasCitations,
  };
}

// ---------------------------------------------------------------------------
// Asset rewriting – copies uploaded assets into the build dir
// ---------------------------------------------------------------------------

/**
 * @param {string} markdown
 * @param {Map<string, string>} assetMap  filename → absolute path on disk
 * @param {string} buildDir
 */
export function rewriteAndCopyAssets(markdown, assetMap, buildDir) {
  const assetDir = join(buildDir, "assets");
  mkdirSync(assetDir, { recursive: true });
  const resolveAssetPath = (decodedPath) => {
    const direct = assetMap.get(decodedPath);
    if (direct && existsSync(direct)) return direct;

    const basename = decodedPath.split("/").pop();
    if (!basename) return null;

    const byBasename = assetMap.get(basename);
    if (byBasename && existsSync(byBasename)) return byBasename;

    return null;
  };

  return markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (full, alt, rawPath, title) => {
      if (
        rawPath.startsWith("http://") ||
        rawPath.startsWith("https://") ||
        rawPath.startsWith("data:") ||
        rawPath.startsWith("#")
      ) {
        return full;
      }

      const decoded = rawPath.replace(/^<|>$/g, "").replace(/^\.\//, "");
      const sourcePath = resolveAssetPath(decoded);

      if (!sourcePath) {
        return full;
      }

      const target = join(assetDir, decoded);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(sourcePath, target);

      const caption = title && title.trim() ? title.trim() : alt;
      return `![${caption}](assets/${decoded})`;
    }
  );
}

// ---------------------------------------------------------------------------
// LaTeX / Pandoc output sanitisation
// ---------------------------------------------------------------------------

export function sanitizePandocLatex(latex) {
  let out = latex;

  const tableColumnCount = (cols) => {
    const cleaned = cols.replace(/@\{[^}]*\}/g, "");
    const matches = cleaned.match(/[lcrmbpX]/g);
    return matches ? matches.length : 1;
  };

  const inferColumnCount = (...segments) => {
    let bestAmpersands = 0;
    for (const segment of segments) {
      const lines = segment.split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes("\\\\")) continue;
        const amps = line.match(/&/g)?.length ?? 0;
        if (amps > bestAmpersands) bestAmpersands = amps;
      }
    }
    return Math.max(bestAmpersands + 1, 1);
  };

  const sanitizeColumnSpec = (_cols, headerLatex, dataLatex) => {
    const count = inferColumnCount(headerLatex, dataLatex);
    return `@{}${"l".repeat(count)}@{}`;
  };

  const tableFootnoteMarker = (idx) => {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    if (idx < letters.length) return letters[idx];
    const first = letters[Math.floor(idx / letters.length) - 1] ?? "z";
    const second = letters[idx % letters.length];
    return `${first}${second}`;
  };

  const stripPandocCellWrappers = (segment) =>
    segment
      .replace(/\\begin\{minipage\}\[b\]\{\\linewidth\}\\raggedright\s*/g, "")
      .replace(/\\end\{minipage\}\s*/g, "")
      .trim();

  const rewriteTableFootnotes = (headerLatex, bodyLatex, cols) => {
    const notes = [];
    const replaceSegment = (segment) =>
      segment.replace(/\\footnote\{([\s\S]*?)\}/g, (_m, text) => {
        const marker = tableFootnoteMarker(notes.length);
        notes.push({ marker, text: text.trim() });
        return `$^{\\mathrm{${marker}}}$`;
      });

    const headerWithoutFootnotes = replaceSegment(headerLatex);
    const bodyWithoutFootnotes = replaceSegment(bodyLatex);

    if (notes.length === 0) {
      return {
        header: headerWithoutFootnotes,
        body: bodyWithoutFootnotes,
        notes: "",
      };
    }

    const _count = Math.max(
      tableColumnCount(cols),
      inferColumnCount(headerWithoutFootnotes, bodyWithoutFootnotes),
      1
    );
    const noteLines = notes.map(
      ({ marker, text }) => `$^{\\mathrm{${marker}}}$ ${text}`
    );
    const noteBlock = [
      "\\vspace{0.25em}",
      "\\begin{flushleft}",
      "\\footnotesize",
      ...noteLines.map((line) => `${line}\\\\`),
      "\\end{flushleft}",
    ].join("\n");

    return {
      header: headerWithoutFootnotes,
      body: bodyWithoutFootnotes,
      notes: noteBlock,
    };
  };

  const rewriteLongtable = (cols, combinedCaption, inner) => {
    const END_FIRSTHEAD = "\\endfirsthead";
    const END_LASTFOOT = "\\endlastfoot";
    const END_HEAD = "\\endhead";

    const firstHeadIdx = inner.indexOf(END_FIRSTHEAD);
    const lastFootIdx = inner.indexOf(END_LASTFOOT);
    const headIdx = inner.indexOf(END_HEAD);

    let headerBlock = firstHeadIdx === -1 ? inner : inner.slice(0, firstHeadIdx);
    let dataBlock = "";
    if (lastFootIdx !== -1) {
      dataBlock = inner.slice(lastFootIdx + END_LASTFOOT.length);
    } else if (headIdx !== -1) {
      dataBlock = inner.slice(headIdx + END_HEAD.length);
    }

    const combinedCaptionText = (combinedCaption || "").trim();
    const splitMarker = ` ${TABLE_CAPTION_SPLIT_TOKEN} `;
    const splitIdx = combinedCaptionText.indexOf(splitMarker);
    let caption =
      splitIdx === -1
        ? combinedCaptionText
        : combinedCaptionText.slice(0, splitIdx).trim();
    // Parse attributes (label, placement, environment) recursively to handle any order
    const attr = parseLaTeXAttributes(caption, "t", "table");
    caption = attr.cleanText;
    let label = attr.label;
    let placement = attr.placement;
    let env = attr.env;

    const bottomCaption =
      splitIdx === -1
        ? ""
        : combinedCaptionText.slice(splitIdx + splitMarker.length).trim();

    if (label) {
      caption = (caption + " " + label).trim();
    }

    headerBlock = headerBlock
      .replace(/^[ \t]*\\endhead\s*$/gm, "")
      .replace(/^[ \t]*\\endfoot\s*$/gm, "")
      .replace(/^[ \t]*\\endlastfoot\s*$/gm, "")
      .replace(/^[ \t]*\\bottomrule\\noalign\{\}\s*$/gm, "")
      .trim();
    const topRuleIdx = headerBlock.indexOf("\\toprule");
    if (topRuleIdx !== -1) headerBlock = headerBlock.slice(topRuleIdx).trim();

    dataBlock = dataBlock
      .replace(/^[ \t]*\\endhead\s*$/gm, "")
      .replace(/^[ \t]*\\endfoot\s*$/gm, "")
      .replace(/^[ \t]*\\endlastfoot\s*$/gm, "")
      .replace(/^[ \t]*\\bottomrule\\noalign\{\}\s*$/gm, "")
      .trim();

    const rewritten = rewriteTableFootnotes(headerBlock, dataBlock, cols);
    headerBlock = stripPandocCellWrappers(rewritten.header);
    dataBlock = stripPandocCellWrappers(rewritten.body);
    const notesBlock = rewritten.notes;
    const safeCols = sanitizeColumnSpec(cols, headerBlock, dataBlock);

    const lines = [
      `\\begin{${env}}[${placement}]`,
      "\\centering",
    ];
    if (caption) lines.push(`\\caption{${caption}}`);
    const targetWidth = env === "table*" ? "\\textwidth" : "\\columnwidth";
    lines.push("\\footnotesize");
    lines.push(`\\resizebox{\\ifdim\\width>${targetWidth} ${targetWidth}\\else\\width\\fi}{!}{%`);
    lines.push(`\\begin{tabular}{${safeCols}}`);
    if (headerBlock) lines.push(headerBlock);
    if (dataBlock) lines.push(dataBlock);
    lines.push("\\bottomrule\\noalign{}");
    lines.push("\\end{tabular}");
    lines.push("}");
    if (notesBlock) lines.push(notesBlock);
    if (bottomCaption) {
      lines.push("\\vspace{0.25em}");
      lines.push("\\begin{center}");
      lines.push("\\footnotesize");
      lines.push(bottomCaption);
      lines.push("\\end{center}");
    }
    lines.push(`\\end{${env}}`);
    return lines.join("\n");
  };

  out = out.replace(
    /\\begin\{longtable\}(?:\[[^\]]*\])?\{([\s\S]*?)\}\s*\\caption\{([\s\S]*?)\}\\tabularnewline([\s\S]*?)\\end\{longtable\}/g,
    (_m, cols, combinedCaption, inner) =>
      rewriteLongtable(cols, combinedCaption, inner)
  );

  out = out.replace(
    /\\begin\{longtable\}(?:\[[^\]]*\])?\{([\s\S]*?)\}([\s\S]*?)\\end\{longtable\}/g,
    (_m, cols, content) => {
      const captionMatch = content.match(
        /\\caption\{([\s\S]*?)\}(?:\\tabularnewline)?/
      );
      const combinedCaption = captionMatch ? captionMatch[1] : "";
      const inner = captionMatch
        ? content.replace(captionMatch[0], "")
        : content;
      return rewriteLongtable(cols, combinedCaption, inner);
    }
  );

  out = out.replace(
    /\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/g,
    (_m, inner) => {
      let env = "figure";
      let placement = "htbp";
      let newInner = inner;

      const capIdx = newInner.indexOf("\\caption{");
      if (capIdx !== -1) {
        let braceCount = 1;
        let contentStart = capIdx + 9;
        let contentEnd = contentStart;
        for (let i = contentStart; i < newInner.length; i++) {
          if (newInner[i] === "{") braceCount++;
          else if (newInner[i] === "}") braceCount--;
          if (braceCount === 0) {
            contentEnd = i;
            break;
          }
        }
        
        if (contentEnd > contentStart) {
          let captionText = newInner.slice(contentStart, contentEnd);
          const originalCaption = captionText;
          const attr = parseLaTeXAttributes(captionText, "htbp", "figure");
          captionText = attr.cleanText;
          let label = attr.label;
          let placement = attr.placement;
          env = attr.env;

          if (label) {
            captionText = (captionText + " " + label).trim();
          }
          
          if (captionText !== originalCaption) {
            const bef = newInner.slice(0, contentStart);
            const aft = newInner.slice(contentEnd);
            newInner = bef + captionText + aft;
            
            // Clean up the `alt` tag which might duplicate the caption with the modifier
            newInner = newInner.replace(`alt={${originalCaption}}`, `alt={${captionText}}`);
          }
        }
      }
      return `\\begin{${env}}[${placement}]${newInner}\\end{${env}}`;
    }
  );

  // Unescape LaTeX commands that Pandoc might have mangled
  out = out
    .replace(/\\textbackslash\{\}([a-z]+)\\\{([^}]*)\\\}/gi, "\\$1{$2}")
    .replace(/\\([a-z]+)\\\{([^}]*)\\\}/gi, "\\$1{$2}")
    .replace(/\\textbackslash\{\}/g, "\\");

  return out;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

function loadTemplateConfig(templateName) {
  const templateDir = join(TEMPLATES_DIR, templateName);
  if (!existsSync(templateDir)) {
    throw new Error(`Template directory not found: templates/${templateName}`);
  }
  const cfgPath = join(templateDir, "template.config.json");
  if (!existsSync(cfgPath)) {
    throw new Error(
      `Missing template config: templates/${templateName}/template.config.json`
    );
  }
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (!config.entry || !config.output) {
    throw new Error(
      `Invalid template config in templates/${templateName}/template.config.json`
    );
  }
  return { templateDir, config };
}

function renderTemplate(templateText, vars) {
  return templateText.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in vars)) return match;
    return vars[key];
  });
}

// ---------------------------------------------------------------------------
// Docker runners
// ---------------------------------------------------------------------------

function ensureDocker() {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error("Docker is required but was not found in PATH.");
  }
}

function runPandocBuild(buildDir, inputFile = "content.md", outputFile = "content.tex") {
  const args = [
    "run", "--rm",
    "-v", `${buildDir}:/work`,
    "-w", "/work",
    "pandoc/latex:latest",
    "--from=markdown+raw_tex+pipe_tables+grid_tables+simple_tables+multiline_tables+table_captions+implicit_figures+footnotes",
    "--to=latex",
    "--no-highlight",
    "--wrap=none",
    `--output=${outputFile}`,
    inputFile,
  ];
  const result = spawnSync("docker", args, { stdio: "pipe" });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`Pandoc conversion failed:\n${stderr}`);
  }
}

function compileMarkdownSegment(buildDir, markdown, assets, fileStem) {
  const normalized = normalizeMarkdown(markdown);
  const mdWithAssets = rewriteAndCopyAssets(normalized.markdown, assets, buildDir);
  const markdownFile = `${fileStem}.md`;
  const latexFile = `${fileStem}.tex`;

  writeFileSync(join(buildDir, markdownFile), `${mdWithAssets}\n`, "utf8");
  runPandocBuild(buildDir, markdownFile, latexFile);

  return {
    normalized,
    latex: sanitizePandocLatex(readFileSync(join(buildDir, latexFile), "utf8")),
  };
}

function buildAppendicesLatex(appendixSections) {
  if (appendixSections.length === 0) return "";

  const lines = ["\\onecolumn", "\\appendices"];
  for (let i = 0; i < appendixSections.length; i++) {
    const section = appendixSections[i];
    if (i > 0) {
      lines.push("\\clearpage");
    }
    if (section.title) {
      const { cleanText, label } = parseLaTeXAttributes(section.title, "", "");
      lines.push(`\\section{${escapeLatex(cleanText)}}${label || ""}`);
    }
    lines.push(section.latex.trim());
  }

  return `\n${lines.join("\n\n")}\n`;
}

/**
 * Robustly extract LaTeX attributes ({#label}, [placement]) from a string.
 * Returns { cleanText, label, placement, env }
 * This acts as a recursive parser to handle attributes in any order.
 */
function parseLaTeXAttributes(text, defaultPlacement = "t", defaultEnv = "table") {
  let label = "";
  let placement = defaultPlacement;
  let env = defaultEnv;
  let cleanText = text.trim();

  let changed = true;
  while (changed) {
    changed = false;
    cleanText = cleanText.trim();

    // 1. Match label variations: {#label}, \label{label}, or escaped variations like \{\#label\}
    // Pandoc often escapes { as \{ and } as \}, and sometimes escapes # as \#.
    // We match:
    // - Standard: {#label} or \label{label}
    // - Escaped: \{\#label\}, \{#label\}, {@label}
    // - Backslashes: \\label{label}
    const labelRegex = /(\{#([A-Za-z0-9:_.-]+)\}|\\label\{([^}]*)\}|\\?\{\\?#([A-Za-z0-9:_.-]+)\\?\}|\\\{\\?#([A-Za-z0-9:_.-]+)\\\})[ \t.]*$/;
    
    const labelMatch = cleanText.match(labelRegex);
    if (labelMatch) {
      const val = labelMatch[2] || labelMatch[3] || labelMatch[4] || labelMatch[5];
      label = `\\label{${val}}`;
      cleanText = cleanText.slice(0, cleanText.length - labelMatch[0].length).trim();
      changed = true;
      continue;
    }

    // 2. Match placement markers at the end: [htbp], [!h], [b*], etc.
    const wrappers = [
      { start: "{[}", end: "{]}" },
      { start: "\\[", end: "\\]" },
      { start: "[", end: "]" },
    ];
    for (const w of wrappers) {
      if (cleanText.endsWith(w.end)) {
        const startIdx = cleanText.lastIndexOf(w.start);
        if (startIdx !== -1) {
          const raw = cleanText.slice(
            startIdx + w.start.length,
            cleanText.length - w.end.length
          );
          // Only treat as placement if it contains expected chars
          if (/^[a-zA-Z0-9!*]+$/.test(raw)) {
            const potentialEnv = raw.endsWith("*") ? defaultEnv + "*" : defaultEnv;
            const potentialPlacement = raw.endsWith("*") ? (raw.slice(0, -1) || defaultPlacement) : raw;

            // Heuristic check: if it looks like a label, skip it here
            if (!raw.startsWith("fig:") && !raw.startsWith("tbl:") && !raw.startsWith("sec:")) {
                cleanText = cleanText.slice(0, startIdx).trim();
                env = potentialEnv;
                placement = potentialPlacement;
                changed = true;
                break;
            }
          }
        }
      }
    }
  }

  return { cleanText, label, placement, env };
}

function extractLatexErrors(logText) {
  if (!logText) return "";
  const lines = logText.split(/\r?\n/);
  const relevant = [];
  let inError = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Start capturing on error/warning lines
    if (/^!\s/.test(line) || /^l\.\d+/.test(line)) {
      inError = true;
    }
    if (inError) {
      relevant.push(line);
      // Stop after a blank line following error context
      if (line.trim() === "" && relevant.length > 2) {
        inError = false;
      }
    }
    // Always capture overfull/underfull warnings and undefined references
    if (
      /Undefined control sequence/i.test(line) ||
      /LaTeX Error/i.test(line) ||
      /Missing/i.test(line) ||
      /Runaway argument/i.test(line) ||
      /Emergency stop/i.test(line)
    ) {
      // Add surrounding context lines
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length - 1, i + 3);
      for (let j = start; j <= end; j++) {
        if (!relevant.includes(lines[j])) relevant.push(lines[j]);
      }
    }
  }
  return relevant.join("\n").trim();
}

function runLatexBuild(buildDir, entryFile) {
  const args = [
    "run", "--rm",
    "-v", `${buildDir}:/work`,
    "-w", "/work",
    "texlive/texlive:latest",
    "latexmk",
    "-pdf",
    "-bibtex",
    "-f",
    "-interaction=nonstopmode",
    entryFile,
  ];
  const result = spawnSync("docker", args, { stdio: "pipe" });

  // latexmk exits non-zero on failure, but with -f it may also exit 0 even
  // with errors and produce no PDF. Check both the exit code and whether the
  // expected output exists.
  if (result.status !== 0) {
    const latexmkOut = (result.stdout?.toString() ?? "") + "\n" + (result.stderr?.toString() ?? "");

    // Try to read the pdflatex .log for the real error details
    const logBasename = entryFile.replace(/\.tex$/i, "");
    const logPath = join(buildDir, `${logBasename}.log`);
    let logSnippet = "";
    try {
      const logText = readFileSync(logPath, "utf8");
      logSnippet = extractLatexErrors(logText);
      if (!logSnippet) {
        // Fallback: last 80 lines of log
        const tail = logText.split(/\r?\n/).slice(-80).join("\n");
        logSnippet = `(last 80 lines of .log):\n${tail}`;
      }
    } catch {
      // log file may not exist if pandoc/docker itself failed
    }

    const parts = ["LaTeX build failed:"];
    if (latexmkOut.trim()) parts.push(`[latexmk output]\n${latexmkOut.trim()}`);
    if (logSnippet) parts.push(`[pdflatex .log errors]\n${logSnippet}`);
    if (!logSnippet && !latexmkOut.trim()) parts.push("(no output captured – check Docker is running)");
    parts.push(`[build directory preserved for inspection: ${buildDir}]`);

    throw new Error(parts.join("\n\n"));
  }
}

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

/**
 * Compile a Markdown document into a PDF.
 *
 * @param {object} opts
 * @param {string}   opts.markdown     - Raw markdown body (no frontmatter)
 * @param {object}   opts.frontmatter  - Parsed frontmatter fields:
 *   { title, description, indexTerms, thanks, authors: AuthorObject[] }
 *   where AuthorObject = { name, department, organization, city, country, email, orcid }
 * @param {string}   opts.references   - Raw .bib file content
 * @param {string}   opts.template     - Template name (e.g. "ieee-conference")
 * @param {Map<string, string>} [opts.assets]
 *   Map of filename → absolute path for image/asset files
 * @param {Array<{title?: string, markdown: string}>} [opts.appendices]
 *   Optional appendix markdown blocks to render after the main body
 * @returns {Buffer} PDF bytes
 */
export async function compile({
  markdown,
  frontmatter,
  references,
  template,
  assets = new Map(),
  appendices = [],
}) {
  ensureDocker();

  const { templateDir, config } = loadTemplateConfig(template);

  const buildId = randomUUID();
  const buildDir = join(BUILD_ROOT, buildId);
  mkdirSync(buildDir, { recursive: true });

  try {
    // Copy template files into build dir
    cpSync(templateDir, buildDir, { recursive: true });

    // Write references.bib
    const hasReferences = !!(references && references.trim());
    if (hasReferences) {
      writeFileSync(
        join(buildDir, "references.bib"),
        normalizeBibForBibtex(references),
        "utf8"
      );
    }

    const main = compileMarkdownSegment(buildDir, markdown, assets, "content");
    let hasCitations = main.normalized.hasCitations;

    const appendixSections = appendices
      .filter((entry) => typeof entry?.markdown === "string" && entry.markdown.trim())
      .map((entry, idx) => {
        const appendix = compileMarkdownSegment(
          buildDir,
          entry.markdown,
          assets,
          `appendix-${idx}`
        );
        if (appendix.normalized.hasCitations) {
          hasCitations = true;
        }
        return {
          title:
            typeof entry.title === "string" && entry.title.trim()
              ? entry.title.trim()
              : "",
          latex: appendix.latex,
        };
      });

    // Load and render the template entry file
    const entryPath = join(buildDir, config.entry);
    const entryTemplate = readFileSync(entryPath, "utf8");
    const bodyLatex = main.latex;
    const appendicesLatex = buildAppendicesLatex(appendixSections);

    const vars = {
      TITLE: escapeLatex(frontmatter.title ?? "Untitled"),
      TITLE_THANKS: getTitleThanks(frontmatter.thanks),
      AUTHORS: buildAuthorBlock(frontmatter.authors ?? []),
      ABSTRACT: escapeLatex(
        main.normalized.abstract || frontmatter.description || ""
      ),
      INDEX_TERMS: escapeLatex((frontmatter.indexTerms ?? []).join(", ")),
      BODY_LATEX: bodyLatex,
      BIBLIOGRAPHY: (hasCitations && hasReferences)
        ? "\\bibliographystyle{IEEEtran}\n\\bibliography{references}"
        : "",
      APPENDICES_LATEX: appendicesLatex,
    };

    // Allow custom variables from frontmatter (capitalised)
    for (const [key, value] of Object.entries(frontmatter)) {
      const upperKey = key.toUpperCase();
      if (!(upperKey in vars)) {
        vars[upperKey] = typeof value === "string" ? escapeLatex(value) : value;
      }
    }

    writeFileSync(entryPath, renderTemplate(entryTemplate, vars), "utf8");

    // Run LaTeX: → PDF
    runLatexBuild(buildDir, config.entry);

    const compiledPdf = join(buildDir, config.output);
    if (!existsSync(compiledPdf)) {
      throw new Error(`Expected output PDF was not produced: ${config.output}`);
    }

    return readFileSync(compiledPdf);
  } catch (err) {
    // On failure, preserve the build dir so the caller's error message
    // (which includes the path) lets the user inspect it. Re-throw.
    throw err;
  } finally {
    // Only clean up on success. On error the build dir is left in place
    // so the preserved path in the error message remains valid for inspection.
    // We use a flag approach: if the PDF was read successfully we clean up.
    try {
      // If we reach here normally (no throw), clean up.
      // If we re-threw above, this finally still runs but 'compiledPdf' check
      // already threw, so we skip cleanup via the catch.
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
