export function parseAllowedChatIds(value = '') {
  return new Set(String(value).split(',').map((id) => id.trim()).filter((id) => /^-?\d+$/.test(id)).map(Number).filter(Number.isSafeInteger));
}

export function isAllowedChat(chatId, allowedChatIds) {
  return Number.isSafeInteger(chatId) && allowedChatIds.has(chatId);
}
