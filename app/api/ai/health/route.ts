import { GET as LegacyGET } from "@/app/api/ai-health/route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return LegacyGET();
}
