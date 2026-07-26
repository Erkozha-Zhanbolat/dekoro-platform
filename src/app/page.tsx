import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-24 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-neutral-800 sm:text-5xl">
        DEKORO B2B
      </h1>
      <p className="max-w-xl text-lg text-neutral-600">
        Платформа для корпоративных клиентов и партнёров
      </p>
      <Link
        href="/catalog"
        className="rounded-md bg-[#0F766E] px-6 py-3 text-base font-medium text-white transition-colors hover:bg-[#0c5f58]"
      >
        Перейти в каталог
      </Link>
    </div>
  );
}
