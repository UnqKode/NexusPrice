// bride between next.js and nextAuth
// basically telling you can use it as get or post request

import NextAuth from "next-auth";
import { authOptions } from "@/lib/authOptions";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };

//Get : can be to get the current session
//Post : can be to present credentials and login
