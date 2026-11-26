import { jsonError, requestContext } from '../../../lib/db';
import { readErpReport, readReportFilters } from '../../../lib/report-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { db, user } = await requestContext(request);
    const now = new Date();
    const { report, window, platform } = readReportFilters(new URL(request.url).searchParams, now);
    return Response.json(await readErpReport(db, user, report, window, now.toISOString(), platform), { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
