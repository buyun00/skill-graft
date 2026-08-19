import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "../components/Providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Skill Hub",
  description: "本机技能控制中心",
};

const themeBoot = `(function(){try{var t=JSON.parse(localStorage.getItem("gg-theme")||"{}");document.documentElement.setAttribute("data-theme",(t.mode==="dark"||t.mode==="light")?t.mode:"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased" data-theme="light">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className={`${inter.variable} min-h-full bg-page`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
