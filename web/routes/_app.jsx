import { useGadget } from "@gadgetinc/react-shopify-app-bridge";
import { useLoaderData, Outlet } from "react-router";
import { NavMenu } from "../components/NavMenu";
import { FullPageSpinner } from "../components/FullPageSpinner";


export const loader = async ({ context }) => {
  return { gadgetConfig: context.gadgetConfig };
};

export default function() {
  const { isAuthenticated, loading } = useGadget();

  if (loading) {
    return <FullPageSpinner />;
  }

  return isAuthenticated ? (
    <>
      <NavMenu />
      <Outlet />
    </>
  ) : (
    <Unauthenticated />
  );
}

const Unauthenticated = () => {
  const { gadgetConfig } = useLoaderData();

    return (
      <div style={{ padding: "16px", backgroundColor: "#F1F1F1", height: "100vh", width: "100vw" }}>
        <s-page>
          <s-section>
            <s-heading>App must be viewed in the Shopify Admin</s-heading>
            <s-box>
              <s-text>Edit this page: </s-text>
              <s-link href={`/edit/${gadgetConfig.environment}/files/web/routes/_app.jsx`}>
                web/routes/_app.jsx
              </s-link>
            </s-box>
          </s-section>
        </s-page>
      </div>
    );
  };
