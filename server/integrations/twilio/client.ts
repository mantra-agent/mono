import { getSecretSync } from "../../secrets-store";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioConfig {
  accountSid: string | null;
  authToken: string | null;
  phoneNumber: string | null;
  hasAccountSid: boolean;
  hasAuthToken: boolean;
  hasPhoneNumber: boolean;
}

export interface TwilioOwnedNumber {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
}

export interface TwilioConnectionResult {
  connected: boolean;
  accountName?: string;
  accountStatus?: string;
  ownedNumbers: TwilioOwnedNumber[];
  configuredNumberOwned: boolean;
  error?: string;
}

interface TwilioAccountResponse {
  friendly_name?: string;
  status?: string;
}

interface TwilioNumbersResponse {
  incoming_phone_numbers?: Array<{
    sid?: string;
    phone_number?: string;
    friendly_name?: string;
  }>;
}

export function getTwilioConfig(): TwilioConfig {
  const accountSid = getSecretSync("TWILIO_ACCOUNT_SID")?.trim() || null;
  const authToken = getSecretSync("TWILIO_AUTH_TOKEN")?.trim() || null;
  const phoneNumber = getSecretSync("TWILIO_PHONE_NUMBER")?.trim() || null;
  return {
    accountSid,
    authToken,
    phoneNumber,
    hasAccountSid: Boolean(accountSid),
    hasAuthToken: Boolean(authToken),
    hasPhoneNumber: Boolean(phoneNumber),
  };
}

async function fetchTwilioJson<T>(url: string, accountSid: string, authToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const providerRequestId = response.headers.get("twilio-request-id");
    throw new Error(`Twilio API returned ${response.status}${providerRequestId ? ` (request ${providerRequestId})` : ""}`);
  }
  return response.json() as Promise<T>;
}

export async function testTwilioConnection(): Promise<TwilioConnectionResult> {
  const config = getTwilioConfig();
  if (!config.accountSid || !config.authToken) {
    return { connected: false, ownedNumbers: [], configuredNumberOwned: false, error: "Account SID and auth token are required." };
  }

  try {
    const encodedSid = encodeURIComponent(config.accountSid);
    const [account, numbers] = await Promise.all([
      fetchTwilioJson<TwilioAccountResponse>(`${TWILIO_API_BASE}/Accounts/${encodedSid}.json`, config.accountSid, config.authToken),
      fetchTwilioJson<TwilioNumbersResponse>(`${TWILIO_API_BASE}/Accounts/${encodedSid}/IncomingPhoneNumbers.json?PageSize=100`, config.accountSid, config.authToken),
    ]);
    const ownedNumbers = (numbers.incoming_phone_numbers ?? []).flatMap((number) => {
      if (!number.sid || !number.phone_number) return [];
      return [{ sid: number.sid, phoneNumber: number.phone_number, friendlyName: number.friendly_name || number.phone_number }];
    });
    return {
      connected: true,
      accountName: account.friendly_name,
      accountStatus: account.status,
      ownedNumbers,
      configuredNumberOwned: Boolean(config.phoneNumber && ownedNumbers.some((number) => number.phoneNumber === config.phoneNumber)),
    };
  } catch (error) {
    return {
      connected: false,
      ownedNumbers: [],
      configuredNumberOwned: false,
      error: error instanceof Error ? error.message : "Twilio connection failed.",
    };
  }
}


export type TwilioCallStatus = "queued" | "ringing" | "in-progress" | "canceled" | "completed" | "busy" | "no-answer" | "failed";

export interface TwilioCall {
  sid: string;
  status: TwilioCallStatus;
}

interface TwilioCallResponse {
  sid?: string;
  status?: TwilioCallStatus;
}

export async function createTwilioCall(input: {
  to: string;
  twimlUrl: string;
  statusCallbackUrl: string;
}): Promise<TwilioCall> {
  const config = getTwilioConfig();
  if (!config.accountSid || !config.authToken || !config.phoneNumber) {
    throw new Error("Twilio account SID, auth token, and phone number are required");
  }
  const form = new URLSearchParams({
    To: input.to,
    From: config.phoneNumber,
    Url: input.twimlUrl,
    Method: "POST",
    StatusCallback: input.statusCallbackUrl,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "initiated ringing answered completed",
  });
  const encodedSid = encodeURIComponent(config.accountSid);
  const call = await fetchTwilioJson<TwilioCallResponse>(
    `${TWILIO_API_BASE}/Accounts/${encodedSid}/Calls.json`,
    config.accountSid,
    config.authToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
  );
  if (!call.sid || !call.status) throw new Error("Twilio returned an incomplete call response");
  return { sid: call.sid, status: call.status };
}
