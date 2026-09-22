/**
 * Create a single-flight parse queue that never drops trailing updates.
 */
export function createParseQueue<T>(parseFn: () => Promise<T>): () => Promise<T> {
  let parseInFlight: Promise<T> | null = null;
  let parseQueued = false;

  const run = async (): Promise<T> => {
    if (parseInFlight) {
      parseQueued = true;
      return parseInFlight;
    }

    parseInFlight = (async () => {
      let result = await parseFn();
      while (parseQueued) {
        parseQueued = false;
        result = await parseFn();
      }
      return result;
    })();

    try {
      return await parseInFlight;
    } finally {
      // A transient read failure must not poison every later refresh.
      parseInFlight = null;
      parseQueued = false;
    }
  };

  return run;
}
