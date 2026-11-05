import {NextResponse} from "next/server";
import {createHash} from "node:crypto";
import {prisma} from "@/lib/db/client";
import {authorizeReply} from "@/lib/prospecting/reply";
import {ProspectingReadError,readProspectingThread,PROSPECTING_USERNAME} from "@/lib/prospecting/read";
import {validateEnrollment,verifyEnrollment} from "@/lib/prospecting/enrollment";
import {privateHeaders,privateJson,scopedMeta} from "@/lib/prospecting/service";
import {discoverProspectingConversations,readProspectingMessages} from "@/lib/prospecting/meta-read";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(request:Request){try{
 const scope=authorizeReply(request.headers.get("authorization"));
 const c=validateEnrollment(await privateJson(request));
 // The historical roster is deliberately excluded from new campaign enrollment.
 if(scope.allowedHandles.has(c.handle))throw new ProspectingReadError(403,"Historical contact cannot enter a new campaign.");
 const {account,accessToken}=await scopedMeta(scope);
 const id=createHash("sha256").update(JSON.stringify([account.instagramId,c.handle])).digest("hex");
 const previous=await prisma.prospectingEnrollment.findUnique({where:{id}});
 const openingHash=createHash("sha256").update(c.opening).digest("hex");
 if(previous){if(previous.campaignId!==c.campaignId||previous.openingHash!==openingHash)throw new ProspectingReadError(409,"Contact belongs to another enrollment.");
 return NextResponse.json({success:true,data:{account:PROSPECTING_USERNAME,handle:c.handle,campaignId:c.campaignId,conversationId:previous.conversationId,verified:true}},{headers:privateHeaders});}
 const thread=await readProspectingThread({handle:c.handle},{...scope,allowedHandles:new Set([c.handle])},{findAccount:async()=>account,conversations:()=>discoverProspectingConversations(accessToken,account.instagramId),messages:(_,conversationId)=>readProspectingMessages(accessToken,conversationId)});
 const proof=verifyEnrollment(c,thread);
 await prisma.prospectingEnrollment.create({data:{id,instagramId:account.instagramId,workspaceId:scope.workspaceId,handle:c.handle,campaignId:c.campaignId,contactedAt:new Date(c.contactedAt),...proof}});
 return NextResponse.json({success:true,data:{account:PROSPECTING_USERNAME,handle:c.handle,campaignId:c.campaignId,conversationId:proof.conversationId,verified:true}},{headers:privateHeaders});
 }catch(error){const known=error instanceof ProspectingReadError;return NextResponse.json({success:false,error:known?error.message:"Enrollment unavailable; never resend first contact."},{status:known?error.status:502,headers:privateHeaders});}}
