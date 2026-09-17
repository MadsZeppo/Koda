/** The caller must return only independently verified candidates. Drain in-flight calls
 * before returning so every charged response is accounted for. */
export async function raceVerified<T>(
  attempts: ((superseded: () => boolean) => Promise<T>)[],
): Promise<T> {
  let won = false;
  const running = attempts.map((fn) => fn(() => won));
  try {
    const winner = await Promise.any(running);
    won = true;
    return winner;
  } finally {
    await Promise.allSettled(running);
  }
}
