// wrangler の Text ルールで文字列として import するモジュールの型宣言
declare module '*.html' {
  const text: string;
  export default text;
}
declare module '*.css' {
  const text: string;
  export default text;
}
declare module '*.webmanifest' {
  const text: string;
  export default text;
}
declare module '*.js' {
  const text: string;
  export default text;
}
