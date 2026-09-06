import type { GymState } from "./types";
const originals = [
  {
    id: "mem_1",
    name: "Priya Sharma",
    email: "priya.sharma@mail.com",
    phone: "+91 98200 41122",
    emergencyContact: "+91 98000 01000",
    demoEmail: "demo.member1@example.com",
  },
  {
    id: "mem_2",
    name: "Rahul Das",
    email: "rahul.das@mail.com",
    phone: "+91 98311 55098",
    emergencyContact: "+91 98000 01001",
    demoEmail: "demo.member2@example.com",
  },
  {
    id: "mem_3",
    name: "Mihir Joshi",
    email: "mihir.joshi@mail.com",
    phone: "+91 99870 22110",
    emergencyContact: "+91 98000 01002",
    demoEmail: "demo.member3@example.com",
  },
  {
    id: "mem_4",
    name: "Aman Singh",
    email: "aman.singh@mail.com",
    phone: "+91 97112 88342",
    emergencyContact: "+91 98000 01003",
    demoEmail: "demo.member4@example.com",
  },
  {
    id: "mem_5",
    name: "Sagar Chhetri",
    email: "sagar.chhetri@mail.com",
    phone: "+91 96001 76542",
    emergencyContact: "+91 98000 01004",
    demoEmail: "demo.member5@example.com",
  },
  {
    id: "mem_6",
    name: "Riya Sharma",
    email: "riya.sharma@mail.com",
    phone: "+91 90045 31278",
    emergencyContact: "+91 98000 01005",
    demoEmail: "demo.member6@example.com",
  },
  {
    id: "mem_7",
    name: "Neha Kapoor",
    email: "neha.kapoor@mail.com",
    phone: "+91 98999 12034",
    emergencyContact: "+91 98000 01006",
    demoEmail: "demo.member7@example.com",
  },
  {
    id: "mem_8",
    name: "Vikram Rathore",
    email: "vikram.rathore@mail.com",
    phone: "+91 93214 65890",
    emergencyContact: "+91 98000 01007",
    demoEmail: "demo.member8@example.com",
  },
  {
    id: "mem_9",
    name: "Ananya Iyer",
    email: "ananya.iyer@mail.com",
    phone: "+91 90876 44521",
    emergencyContact: "+91 98000 01008",
    demoEmail: "demo.member9@example.com",
  },
  {
    id: "mem_10",
    name: "Karan Mehta",
    email: "karan.mehta@mail.com",
    phone: "+91 98115 77320",
    emergencyContact: "+91 98000 01009",
    demoEmail: "demo.member10@example.com",
  },
  {
    id: "mem_11",
    name: "Sneha Patil",
    email: "sneha.patil@mail.com",
    phone: "+91 99201 33447",
    emergencyContact: "+91 98000 01010",
    demoEmail: "demo.member11@example.com",
  },
  {
    id: "mem_12",
    name: "Arjun Nair",
    email: "arjun.nair@mail.com",
    phone: "+91 97404 91230",
    emergencyContact: "+91 98000 01011",
    demoEmail: "demo.member12@example.com",
  },
  {
    id: "mem_13",
    name: "Divya Menon",
    email: "divya.menon@mail.com",
    phone: "+91 96320 87451",
    emergencyContact: "+91 98000 01012",
    demoEmail: "demo.member13@example.com",
  },
  {
    id: "mem_14",
    name: "Rohit Verma",
    email: "rohit.verma@mail.com",
    phone: "+91 98700 65412",
    emergencyContact: "+91 98000 01013",
    demoEmail: "demo.member14@example.com",
  },
  {
    id: "mem_15",
    name: "Tanvi Desai",
    email: "tanvi.desai@mail.com",
    phone: "+91 90909 11223",
    emergencyContact: "+91 98000 01014",
    demoEmail: "demo.member15@example.com",
  },
  {
    id: "mem_16",
    name: "Imran Sheikh",
    email: "imran.sheikh@mail.com",
    phone: "+91 93456 78210",
    emergencyContact: "+91 98000 01015",
    demoEmail: "demo.member16@example.com",
  },
  {
    id: "inq_demo_aarav",
    name: "Aarav Sharma",
    email: "aarav.sharma@example.com",
    phone: "+977 9812345678",
    demoEmail: "demo.inquiry1@example.com",
  },
  {
    id: "inq_demo_sita",
    name: "Sita Gurung",
    email: "sita.gurung@example.com",
    phone: "+977 9807654321",
    demoEmail: "demo.inquiry2@example.com",
  },
];
const digits = (value: string) => value.replace(/\D/g, "").slice(-10);
/** Migrate only unchanged seeded contacts; edited and user-created records are preserved. */
export function anonymizeDemoContacts(state: GymState): GymState {
  function clean<
    T extends {
      id: string;
      name: string;
      phone: string;
      email?: string;
      emergencyContact?: string;
    },
  >(record: T): T {
    const original = originals.find((item) => item.id === record.id && item.name === record.name);
    if (!original) return record;
    return {
      ...record,
      phone: digits(record.phone) === digits(original.phone) ? "0000000000" : record.phone,
      email: record.email === original.email ? original.demoEmail : record.email,
      ...("emergencyContact" in record &&
      "emergencyContact" in original &&
      record.emergencyContact &&
      digits(record.emergencyContact) === digits(original.emergencyContact!)
        ? { emergencyContact: "0000000000" }
        : {}),
    };
  }
  return {
    ...state,
    members: state.members.map(clean),
    inquiries: (state.inquiries ?? []).map(clean),
  };
}
