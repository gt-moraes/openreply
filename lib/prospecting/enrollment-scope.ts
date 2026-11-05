import {prisma} from "@/lib/db/client";
import {scopedMeta,type ProspectingScope} from "./service";
import {prospectDenied} from "./enrollment";
export async function enrolledScope(scope:ProspectingScope,selectors:unknown,onlyEnrolled=false):Promise<ProspectingScope>{
 const handles=Array.isArray(selectors)?selectors.filter((h):h is string=>typeof h==="string"&&/^[a-z0-9._]{1,30}$/.test(h)&&!prospectDenied.has(h)).slice(0,100):[];
 const {account}=await scopedMeta(scope);
 const rows=handles.length?await prisma.prospectingEnrollment.findMany({where:{instagramId:account.instagramId,workspaceId:scope.workspaceId,handle:{in:handles}},select:{handle:true,conversationId:true,contactedAt:true}}):[];
 return {...scope,enrollments:new Map(rows.map(r=>[r.handle,{conversationId:r.conversationId,contactedAt:r.contactedAt}])),allowedHandles:new Set([...(onlyEnrolled?[]:scope.allowedHandles),...rows.map(r=>r.handle)])};
}
