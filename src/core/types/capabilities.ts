/** Each template selects exactly one execution contract. */
export type LaunchCommand =
  { argv: string[]; shell?: never; shellPath?: never } | { shell: string; shellPath: string; argv?: never };
