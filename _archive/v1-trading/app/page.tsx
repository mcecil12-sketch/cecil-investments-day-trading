import { redirect } from "next/navigation";

// Redirect root to /today
export default function HomePage() {
  redirect("/today");
}
