declare module 'expo-server-sdk' {
  export interface ExpoClientOptions {
    accessToken?: string;
  }

  export interface ExpoPushMessage {
    to: string | string[];
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    sound?: 'default' | null;
    priority?: 'default' | 'normal' | 'high';
    channelId?: string;
    ttl?: number;
  }

  export interface ExpoPushSuccessTicket {
    status: 'ok';
    id: string;
  }

  export interface ExpoPushErrorTicket {
    status: 'error';
    message: string;
    details?: {
      error?:
        | 'DeviceNotRegistered'
        | 'MessageTooBig'
        | 'MessageRateExceeded'
        | 'MismatchSenderId'
        | 'InvalidCredentials';
    };
  }

  export type ExpoPushTicket = ExpoPushSuccessTicket | ExpoPushErrorTicket;

  export class Expo {
    constructor(options?: ExpoClientOptions);
    static isExpoPushToken(token: string): boolean;
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
    sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  }
}
