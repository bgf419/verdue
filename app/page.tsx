import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import ClaimApp from "./ClaimApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const authenticatedUser = await getChatGPTUser();
  const user = authenticatedUser
    ? { displayName: authenticatedUser.displayName, email: authenticatedUser.email }
    : null;

  return <ClaimApp user={user} signInPath={chatGPTSignInPath("/")} />;
}
