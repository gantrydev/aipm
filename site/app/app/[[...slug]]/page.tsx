import AppDashboardPage from "./page-client";

export function generateStaticParams() {
  return [{ slug: [] as Array<string> }];
}

const Page = () => <AppDashboardPage />;

export default Page;
