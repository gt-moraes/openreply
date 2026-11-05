import {createHash} from "node:crypto";
import {ProspectingReadError,PROSPECTING_USERNAME,type readProspectingThread} from "./read";
export type EnrollmentCommand={handle:string;campaignId:string;opening:string;contactedAt:string};
export const prospectDenied=new Set(["nutribrunanogs","levonshape","renanjacobi","gteodoro.ia",PROSPECTING_USERNAME]);
export function validateEnrollment(body:unknown):EnrollmentCommand{
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="campaignId,contactedAt,handle,opening")throw new ProspectingReadError(400,"Invalid enrollment.");
 const c=body as EnrollmentCommand;
 if(typeof c.handle!=="string"||!/^[a-z0-9._]{1,30}$/.test(c.handle)||prospectDenied.has(c.handle)||typeof c.campaignId!=="string"||!/^[a-f0-9-]{36}$/.test(c.campaignId)||typeof c.opening!=="string"||!c.opening.trim()||Buffer.byteLength(c.opening,"utf8")>1000||typeof c.contactedAt!=="string"||!Number.isFinite(Date.parse(c.contactedAt)))throw new ProspectingReadError(400,"Invalid enrollment.");
 return c;
}
export function verifyEnrollment(c:EnrollmentCommand,thread:Awaited<ReturnType<typeof readProspectingThread>>,now=Date.now()){
 const at=Date.parse(c.contactedAt),messages=thread.messages,first=messages[0];
 if(at>now||now-at>=86400000||thread.account!==PROSPECTING_USERNAME||thread.handle!==c.handle||!first||first.author!=="self"||!first.authorConfirmed||first.text!==c.opening||!first.createdAt||Math.abs(Date.parse(first.createdAt)-at)>60000||messages.some(m=>!m.authorConfirmed||m.truncated||!m.createdAt||Date.parse(m.createdAt)<at-60000||Date.parse(m.createdAt)>now))throw new ProspectingReadError(409,"First contact could not be verified; never resend it.");
 return {conversationId:thread.conversationId,openingMessageId:first.id,openingHash:createHash("sha256").update(c.opening).digest("hex")};
}
