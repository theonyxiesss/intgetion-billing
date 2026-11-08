/** Start and Hire stay at 2. An active Team purchase raises that company to 10. */
export const START_SEATS = 2;
export const TEAM_SEATS = 10;

export function seatCap(hasActiveTeam: boolean): number {
  return hasActiveTeam ? TEAM_SEATS : START_SEATS;
}
