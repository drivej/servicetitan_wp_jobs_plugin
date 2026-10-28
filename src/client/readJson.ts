/** Read JSON endpoints while recognizing the legacy plain-text seed fallback. */
export const readJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text.trim()) throw new Error(`The app server returned an empty response (HTTP ${response.status}).`);
  if (!response.ok && text.trim() === 'try your best') {
    throw new Error('There is not enough supported project information to generate this post. Add project details and try again.');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The app server returned an invalid response (HTTP ${response.status}).`);
  }
};
