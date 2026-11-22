/** Concept §6.3; contract 06 “Reader、coverage 与树”: first exhausted limit stops the read. */
export interface ReaderBudget {
  maxBytes: number;
  maxRecords: number;
  budgetMs: number;
}
