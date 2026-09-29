/**
 * Candidate scoring for the recruitment pipeline.
 *
 * Deliberately deterministic: every point comes from a value the applicant actually
 * typed, or from a keyword the job actually asked for. No model, no inference, no
 * "AI guess". Two consequences that matter to HR:
 *
 *   1. The score can be explained. `factors[]` says exactly where each point came
 *      from, so a candidate who ranks low can be defended ("no resume on file") rather
 *      than mysteriously buried.
 *   2. The score is reproducible. Re-scoring the same application gives the same
 *      number, so sorting is stable and audits are meaningful.
 *
 * What this does NOT do: read inside a PDF or DOCX. Resume *text* is not available to
 * the backend today (no extraction dependency is installed), so resume content cannot
 * contribute to the score — only its presence does. That is a deliberate Phase-1
 * boundary, not an oversight; see the "resume" factor below.
 */

/**
 * Weights are the whole policy. Kept in one exported object so HR can see and tune the
 * relative importance instead of hunting magic numbers through the logic.
 * They sum to 100 so the final score reads directly as a percentage.
 */
export const WEIGHTS = {
  experience: 30,
  qualification: 15,
  keywords: 25,
  salary: 15,
  completeness: 10,
  resume: 5,
};

/** Score bands, highest first. First match wins. */
export const BANDS = [
  { id: 'excellent', label: 'Excellent', min: 80 },
  { id: 'good', label: 'Good', min: 60 },
  { id: 'fair', label: 'Fair', min: 40 },
  { id: 'weak', label: 'Weak', min: 0 },
];

export const bandFor = (score) => BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];

// ── helpers ────────────────────────────────────────────────────────────────────

const clean = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Pull a year count out of the free-text `experience` field. That field is hand-typed
 * by admin ("3 years", "2-4 yrs", "Fresher", "5"), so this has to tolerate all of it.
 *
 * Returns null when nothing usable is present — distinct from 0, because "we don't
 * know" must not score the same as "no experience".
 */
export const parseExperienceYears = (value) => {
  const text = clean(value);
  if (!text) return null;
  if (/(fresher|freshers|entry level|no experience)/.test(text)) return 0;

  // "2-4 years" / "2 to 4" -> take the lower bound; a range means "at least 2".
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
  if (range) return parseFloat(range[1]);

  const single = text.match(/(\d+(?:\.\d+)?)/);
  return single ? parseFloat(single[1]) : null;
};

/**
 * Split requirement text into comparable keyword stems.
 *
 * Stop-words are dropped because they appear in every job description and would
 * reward noise. Terms under 3 chars are dropped for the same reason.
 */
const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'must', 'have',
  'has', 'that', 'this', 'from', 'able', 'should', 'ability', 'work', 'working',
  'good', 'strong', 'well', 'plus', 'etc', 'years', 'year', 'experience', 'knowledge',
  'skills', 'skill', 'candidate', 'role', 'job', 'team', 'company', 'including',
]);

export const keywordsFrom = (text) => {
  // Collapse punctuation to spaces EXCEPT the in-word separators that carry meaning
  // ("front-end", "node.js", "c/c++"). Then drop a trailing/leading separator only —
  // previously a blanket strip turned "front-end" into "front" and "end", which
  // silently destroyed the term and made every such keyword unmatchable.
  const tokens = clean(text)
    .replace(/[^a-z0-9\s+#./-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[./-]+/, '').replace(/[./-]+$/, ''))
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens));
};

/**
 * The text an applicant's own submission is searched for keywords. Built only from
 * fields they filled — nothing is invented.
 */
const candidateHaystack = (candidate, job) =>
  [
    candidate?.name,
    candidate?.qualification,
    candidate?.experience,
    candidate?.currentEmployer,
    candidate?.city,
    candidate?.state,
    candidate?.notes,
    Array.isArray(candidate?.tags) ? candidate.tags.join(' ') : '',
    job?.title,
    job?.designation,
    job?.department,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

/**
 * Match a keyword against the haystack, tracking WHY it matched.
 *
 * A bare substring test would count "hr" as present because it appears inside
 * "sharma", which inflates scores for short keywords and would make the explanation
 * look wrong to anyone who checks. Splitting the two cases keeps the detail string
 * honest: `whole` is a genuine word match, `partial` is a substring that happens to
 * occur. Both score, but the UI can show which is which.
 */
const matchKind = (haystack, keyword) => {
  if (!keyword) return null;
  // Escape regex metacharacters — keywords routinely contain . + / -
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundary = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  if (wordBoundary.test(haystack)) return 'whole';
  return haystack.includes(keyword) ? 'partial' : null;
};

// ── main ───────────────────────────────────────────────────────────────────────

/**
 * Score one candidate against one opening.
 *
 * @param {object} candidate  Candidate document or plain object.
 * @param {object} job        JobOpening document or plain object. May be null — a
 *                            candidate with no opening still gets a (partial) score
 *                            rather than being silently ranked last.
 * @returns {{score:number, band:object, factors:Array, keyMatches:string[],
 *            keyMisses:string[], missingFields:string[]}}
 */
export const scoreCandidate = (candidate = {}, job = null) => {
  const factors = [];

  const add = (id, label, points, max, detail) => {
    factors.push({ id, label, points: Math.round(points * 10) / 10, max, detail });
  };

  // ── 1. Experience ───────────────────────────────────────────────────────────
  // Scored against what the opening asked for. A candidate applying with no opening
  // gets a neutral half-credit rather than zero, so they are not penalised for
  // missing context rather than missing experience.
  const wanted = parseExperienceYears(job?.experienceRequired);
  const has = parseExperienceYears(candidate?.experience);

  if (has === null) {
    add('experience', 'Experience', 0, WEIGHTS.experience, 'Not stated by applicant');
  } else if (wanted === null) {
    // No stated requirement: reward experience up to the cap, gently.
    const pts = Math.min(has / 5, 1) * WEIGHTS.experience * 0.6;
    add('experience', 'Experience', pts, WEIGHTS.experience,
      `${has} yrs (opening states no requirement)`);
  } else if (wanted === 0) {
    // Explicitly a fresher role — experienced applicants are fine but not "better".
    const pts = WEIGHTS.experience * (has === 0 ? 1 : 0.7);
    add('experience', 'Experience', pts, WEIGHTS.experience,
      has === 0 ? 'Fresher — matches opening' : `${has} yrs (opening open to freshers)`);
  } else if (has >= wanted) {
    // Meeting the bar is worth full marks; large overshoot is mildly discounted
    // because a 15-year applicant for a 2-year role usually signals a mismatch.
    const overshoot = (has - wanted) / Math.max(wanted, 1);
    const pts = WEIGHTS.experience * (overshoot > 1 ? 0.85 : 1);
    add('experience', 'Experience', pts, WEIGHTS.experience,
      `${has} yrs vs ${wanted} wanted`);
  } else {
    // Short of the bar — proportional, so 1 of 2 years is not scored like 0 of 2.
    const ratio = has / wanted;
    add('experience', 'Experience', WEIGHTS.experience * ratio, WEIGHTS.experience,
      `${has} yrs vs ${wanted} wanted`);
  }

  // ── 2. Qualification ────────────────────────────────────────────────────────
  // Presence and level only. We cannot verify a qualification, so this measures
  // whether the field was filled at all — which is what "completeness of application"
  // legitimately means, and is stated as such in the detail string.
  const qual = clean(candidate?.qualification);
  if (!qual) {
    add('qualification', 'Qualification', 0, WEIGHTS.qualification, 'Not stated by applicant');
  } else {
    const level = /(ph\.?d|doctorate)/.test(qual) ? 3
      : /(m\.?tech|mba|m\.?com|m\.?sc|m\.?a|master|post\s?grad|pg)/.test(qual) ? 2
      : /(b\.?tech|b\.?e\b|b\.?com|b\.?sc|b\.?a|bachelor|b\.?b\.?a|graduate|degree|diploma)/.test(qual) ? 1
      : 0.5;
    add('qualification', 'Qualification', (level / 3) * WEIGHTS.qualification,
      WEIGHTS.qualification, candidate.qualification);
  }

  // ── 3. Keyword match ────────────────────────────────────────────────────────
  // Prefer explicit job keywords; fall back to mining the requirements/description.
  const jobKeywords = Array.isArray(job?.keywords) && job.keywords.length
    ? job.keywords.map((k) => clean(k)).filter(Boolean)
    : keywordsFrom([job?.requirements, job?.description].filter(Boolean).join(' '));

  const haystack = candidateHaystack(candidate, job);
  const matched = jobKeywords
    .map((k) => ({ keyword: k, kind: matchKind(haystack, k) }))
    .filter((m) => m.kind);
  const keyMatches = matched.map((m) => m.keyword);
  const keyMisses = jobKeywords.filter((k) => !keyMatches.includes(k));

  if (!jobKeywords.length) {
    add('keywords', 'Keyword match', WEIGHTS.keywords * 0.5, WEIGHTS.keywords,
      'Opening lists no requirements to match');
  } else {
    const ratio = keyMatches.length / jobKeywords.length;
    const partialCount = matched.filter((m) => m.kind === 'partial').length;
    add('keywords', 'Keyword match', ratio * WEIGHTS.keywords, WEIGHTS.keywords,
      `${keyMatches.length} of ${jobKeywords.length} requirement terms present`
      + (partialCount ? ` (${partialCount} partial)` : ''));
  }

  // ── 4. Salary fit ───────────────────────────────────────────────────────────
  // Compared in the same unit as the band. A candidate asking above the top of the
  // band is not "bad" — they are just more likely to decline — so this degrades
  // smoothly instead of zeroing.
  const askRaw = Number(candidate?.expectedSalary) || 0;
  const bandMin = Number(job?.salaryRange?.min) || 0;
  const bandMax = Number(job?.salaryRange?.max) || 0;
  const period = job?.salaryRange?.period || 'year';
  // `expectedSalary` is stored as a yearly figure by the admin form.
  const ask = period === 'month' ? askRaw / 12 : askRaw;

  if (!askRaw || !bandMax) {
    add('salary', 'Salary fit', WEIGHTS.salary * 0.5, WEIGHTS.salary,
      askRaw ? 'Opening states no salary band' : 'Not stated by applicant');
  } else if (ask <= bandMax && (bandMin === 0 || ask >= bandMin * 0.8)) {
    add('salary', 'Salary fit', WEIGHTS.salary, WEIGHTS.salary, 'Within the stated band');
  } else if (ask < bandMin * 0.8) {
    // Below band — usually fine, occasionally a seniority signal. Small deduction.
    add('salary', 'Salary fit', WEIGHTS.salary * 0.85, WEIGHTS.salary, 'Below the stated band');
  } else {
    const over = (ask - bandMax) / bandMax;
    const ratio = Math.max(0, 1 - over * 2); // 50% over budget scores zero
    add('salary', 'Salary fit', ratio * WEIGHTS.salary, WEIGHTS.salary,
      `${Math.round(over * 100)}% above the stated band`);
  }

  // ── 5. Application completeness ─────────────────────────────────────────────
  // What can we actually contact and process? Weighted because a candidate we cannot
  // reach is not actionable regardless of how good their profile reads.
  const checks = [
    { key: 'email', label: 'email', ok: Boolean(clean(candidate?.email)) },
    { key: 'mobile', label: 'mobile', ok: Boolean(clean(candidate?.mobile)) },
    { key: 'city', label: 'location', ok: Boolean(clean(candidate?.city)) },
    { key: 'expectedSalary', label: 'expected salary', ok: Boolean(Number(candidate?.expectedSalary)) },
  ];
  const present = checks.filter((c) => c.ok);
  const missingFields = checks.filter((c) => !c.ok).map((c) => c.label);
  add('completeness', 'Application completeness',
    (present.length / checks.length) * WEIGHTS.completeness, WEIGHTS.completeness,
    missingFields.length ? `Missing: ${missingFields.join(', ')}` : 'All key fields provided');

  // ── 6. Resume on file ───────────────────────────────────────────────────────
  // Presence only. Resume *content* is intentionally not scored — extracting text from
  // PDF/DOCX needs a parser that is not installed, and guessing from the filename
  // would be noise dressed as signal.
  const hasResume = Boolean(candidate?.resume?.url);
  add('resume', 'Resume attached', hasResume ? WEIGHTS.resume : 0, WEIGHTS.resume,
    hasResume ? 'Resume on file' : 'No resume attached');

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    band: bandFor(score),
    factors,
    keyMatches,
    // Matches with their match kind, so the UI can show "field sales ✓" confidently
    // and flag the loose ones separately.
    keywordDetail: matched,
    keyMisses,
    missingFields,
    scoredAt: new Date().toISOString(),
  };
};

/**
 * Sort helper used by the candidates list so ranking is identical everywhere
 * (API, CSV export, UI). Ties fall back to newest-first, then id, so ordering is
 * total and stable — an unstable sort would make the list appear to reshuffle.
 */
export const compareByScore = (scoreOf) => (a, b) => {
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (sb !== sa) return sb - sa;
  const ta = new Date(a?.createdAt || 0).getTime();
  const tb = new Date(b?.createdAt || 0).getTime();
  if (tb !== ta) return tb - ta;
  return String(a?._id || '').localeCompare(String(b?._id || ''));
};

export default { scoreCandidate, compareByScore, parseExperienceYears, keywordsFrom, WEIGHTS, BANDS, bandFor };
