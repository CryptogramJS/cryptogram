export async function sha256(str){
    const data  = new TextEncoder().encode(str);
    const hash  = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)]
             .map(b => b.toString(16).padStart(2,"0"))
             .join("");
}