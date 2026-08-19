export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(endpoint, options);
  if (!res.ok) {
    throw new Error(`API returned ${res.status}`);
  }
  return res.json();
}
