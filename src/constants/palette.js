export const CHARACTER_COLOR_PALETTE = ['#6b9bd1', '#e8a849', '#a86bd1', '#6bd1a8']

export function characterColor(index) {
  return CHARACTER_COLOR_PALETTE[index % CHARACTER_COLOR_PALETTE.length]
}
