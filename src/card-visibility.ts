/** Independently composable rich-card contents; identity and status always remain visible. */
export interface CardVisibility {
  cardLabel: boolean;
  cardOriginalName: boolean;
  cardSummary: boolean;
  cardRelations: boolean;
  cardAction: boolean;
  cardSubagents: boolean;
  cardSubagentSummary: boolean;
  /** Important includes live, failed, flagged and key-role descendants. */
  cardSubagentScope: 'live' | 'important' | 'all';
  cardRoleCounts: boolean;
  cardModel: boolean;
  cardReviews: boolean;
  cardClock: boolean;
  cardRate: boolean;
  cardContext: boolean;
}

export function defaultCardVisibility(): CardVisibility {
  return { cardLabel: true, cardOriginalName: false, cardSummary: true, cardRelations: true,
    cardAction: true, cardSubagents: true, cardSubagentSummary: true, cardSubagentScope: 'important',
    cardRoleCounts: true, cardModel: true, cardReviews: true, cardClock: true, cardRate: true, cardContext: true };
}
