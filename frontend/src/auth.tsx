import { createContext,useContext,useEffect,useState,type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api,setToken,type User,type AuthResult } from './api';

type Auth={user:User|null;loading:boolean;login:(username:string,password:string)=>Promise<void>;logout:()=>Promise<void>};
const Context=createContext<Auth|null>(null);
export function AuthProvider({children}:{children:ReactNode}){
  const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
  const cache=useQueryClient();
  const clear=()=>{setToken(null);setUser(null);cache.clear();};
  useEffect(()=>{
    let mounted=true;
    api<AuthResult>('/auth/session',{method:'POST'}).then(result=>{if(mounted){setToken(result.accessToken);setUser(result.user);}})
      .catch(()=>{if(mounted)clear();}).finally(()=>{if(mounted)setLoading(false);});
    const expired=()=>clear();window.addEventListener('auth:expired',expired);
    return()=>{mounted=false;window.removeEventListener('auth:expired',expired);};
  },[]);
  async function login(username:string,password:string){
    const result=await api<AuthResult>('/auth/login',{method:'POST',body:JSON.stringify({username,password})});
    cache.clear();setToken(result.accessToken);setUser(result.user);
  }
  async function logout(){await api('/auth/logout',{method:'POST'});clear();}
  return <Context.Provider value={{user,loading,login,logout}}>{children}</Context.Provider>;
}
export function useAuth(){return useContext(Context)!;}
