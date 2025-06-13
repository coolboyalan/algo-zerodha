export function getISTMidnightFakeUTCString() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;

  // Get IST time
  const istNow = new Date(now.getTime() + istOffsetMs);

  // Get IST date parts
  const year = istNow.getUTCFullYear();
  const month = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istNow.getUTCDate()).padStart(2, "0");

  // Return the ISO string as if IST midnight is UTC midnight
  return `${year}-${month}-${day}T00:00:00.000Z`;
}
