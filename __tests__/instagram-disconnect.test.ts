import {describe,it,expect,vi,beforeEach} from "vitest";
import {NextRequest} from "next/server";
const mocks=vi.hoisted(()=>({context:vi.fn(),canManage:vi.fn(),find:vi.fn(),remove:vi.fn(),legacyRemove:vi.fn(),transaction:vi.fn()}));
vi.mock("@/lib/db/client",()=>({prisma:{$transaction:mocks.transaction,instagramAccount:{deleteMany:mocks.legacyRemove}}}));
vi.mock("@/lib/workspace-access",()=>({getCurrentWorkspaceContext:mocks.context,canManageWorkspace:mocks.canManage}));
import {POST} from "@/app/api/instagram/disconnect/route";
const counts={automations:0,dmLogs:0,linkClicks:0,followerSnapshots:0,reelPublications:0};
const request=(body:unknown)=>new NextRequest("https://example.test/api/instagram/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockResolvedValue({workspaceId:"workspace",role:"OWNER"});mocks.canManage.mockReturnValue(true);mocks.find.mockResolvedValue({id:"account",_count:counts});mocks.remove.mockResolvedValue({count:1});mocks.legacyRemove.mockResolvedValue({count:1});mocks.transaction.mockImplementation(async fn=>fn({instagramAccount:{findFirst:mocks.find,deleteMany:mocks.remove}}));});
describe("disconnect data preservation",()=>{
 it("requires an explicit account and never deletes every account by default",async()=>{for(const body of [{},{instagramAccountId:""},[],null]){const r=await POST(request(body));expect(r.status).toBe(400);}expect(mocks.legacyRemove).not.toHaveBeenCalled();expect(mocks.remove).not.toHaveBeenCalled();});
 it("refuses deletion of any account with campaign or historical data",async()=>{for(const field of Object.keys(counts)){mocks.find.mockResolvedValue({id:"account",_count:{...counts,[field]:1}});const r=await POST(request({instagramAccountId:"account"}));expect(r.status).toBe(409);}expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.legacyRemove).not.toHaveBeenCalled();});
 it("only removes an empty explicitly selected owned account in serializable transaction",async()=>{const r=await POST(request({instagramAccountId:"account"}));expect(r.status).toBe(200);expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:"Serializable"});expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({where:{id:"account",workspaceId:"workspace"}}));expect(mocks.remove).toHaveBeenCalledWith({where:{id:"account",workspaceId:"workspace"}});});
 it("denies missing accounts and non-admins without removing data",async()=>{mocks.find.mockResolvedValue(null);expect((await POST(request({instagramAccountId:"foreign"}))).status).toBe(404);expect(mocks.remove).not.toHaveBeenCalled();mocks.canManage.mockReturnValue(false);expect((await POST(request({instagramAccountId:"account"}))).status).toBe(403);});
});
