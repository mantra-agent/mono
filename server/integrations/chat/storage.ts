import { chatFileStorage, type IChatFileStorage } from "../../chat-file-storage";

export type { IChatFileStorage as IChatStorage };
export type { FileSession as Session, FileMessage as Message } from "../../chat-file-storage";

export const chatStorage = chatFileStorage;
